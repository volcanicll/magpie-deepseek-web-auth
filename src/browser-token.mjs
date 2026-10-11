// Browser profiles
//
// The sign-in looks for a signed-in chat.deepseek.com session in the browsers
// whose local storage can be read on this machine. Chromium keeps Local Storage
// in a leveldb under the profile; a small UTF-16 scan of it finds the
// `userToken` entry the page wrote, which is what a sign-in here needs. The
// browsers are read, never written, and nothing but the token is taken.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { headers } from "./api.mjs"

// The Chromium-family browsers, as each names its profile data per platform.
// Every entry is the browser's user-data directory, which holds one directory
// per profile (Default, Profile 1, …).
function browserDataDirs() {
  const home = homedir()
  const names = {
    darwin: [
      "Google/Chrome",
      "Chromium",
      "BraveSoftware/Brave-Browser",
      "Microsoft Edge",
      "Vivaldi",
      "Arc",
      "Google/Chrome Beta",
      "Google/Chrome Canary",
    ],
    linux: ["google-chrome", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"],
    win32: ["Google/Chrome/User Data", "Chromium/User Data", "BraveSoftware/Brave-Browser/User Data", "Microsoft/Edge/User Data"],
  }
  const base = process.platform === "darwin"
    ? join(home, "Library/Application Support")
    : process.platform === "linux"
      ? join(home, ".config")
      : process.env.LOCALAPPDATA ?? ""
  if (!base) return []
  return (names[process.platform] ?? []).map((name) => join(base, name)).filter((dir) => existsSync(dir))
}

// profileDirs are the per-profile directories of a browser's user-data
// directory: only ones that actually carry a Local Storage leveldb.
function profileDirs(dataDir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dataDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // A browser's own data dir can also nest its profiles (Chrome → "User Data").
    if (/^(User Data)$/.test(entry.name)) {
      out.push(...profileDirs(join(dataDir, entry.name)))
      continue
    }
    if (!/^(Default|Profile \d+|Guest Profile|System Profile)$/.test(entry.name)) continue
    const level = join(dataDir, entry.name, "Local Storage/leveldb")
    if (existsSync(level)) out.push(level)
  }
  return out
}

// chromiumRoots returns every readable Local Storage leveldb on this machine.
function chromiumRoots() {
  const roots = []
  for (const dir of browserDataDirs()) for (const level of profileDirs(dir)) if (!roots.includes(level)) roots.push(level)
  return roots
}

const USER_TOKEN_KEY = "userToken"

// A chat.deepseek.com session token: the page writes 64 characters of base64
// alphabet, and its Local Storage record holds the key and then the value. The
// byte after the value is arbitrary (the record continues with other keys), so
// the run is read whole and the lengths the app uses are offered as candidates
// rather than guessing where the value stops.
const USER_TOKEN_VALUE = /[A-Za-z0-9+/]{40,}={0,2}/g
const TOKEN_LENGTH = 64

// tokenFromLevelDb looks for the `userToken` key in a profile's Local Storage
// leveldb files and takes the token that trails it. Chromium writes the key as
// plain text and the value right after it in the same record, so the first
// long base64ish run after the key is the token; the newest files are read
// first, since the most recent write carries the live one. Several candidates
// can come out of a profile (old sessions, other tabs); the caller checks them
// against DeepSeek and keeps the one that answers.
function tokenCandidatesFromLevelDb(dir) {
  let files
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".ldb") || name.endsWith(".log"))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
  files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })
  const seen = new Set()
  for (const file of files) {
    let buffer
    try {
      buffer = readFileSync(file)
    } catch {
      continue
    }
    for (const needle of [Buffer.from(USER_TOKEN_KEY, "utf8"), Buffer.from(USER_TOKEN_KEY, "utf16le")]) {
      let at = 0
      while ((at = buffer.indexOf(needle, at)) !== -1) {
        // The value sits just past the key: read a little in as text and take
        // the first token-shaped run.
        const window = buffer.subarray(at + needle.length, at + needle.length + 4096).toString("utf8")
        USER_TOKEN_VALUE.lastIndex = 0
        const found = USER_TOKEN_VALUE.exec(window)
        if (found) {
          const run = found[0]
          // The app writes a TOKEN_LENGTH-character token, and the byte that
          // follows it in the record can be another base64 character, so the
          // run can be one longer than the token. Offer the app's length first,
          // then the run, and let the caller's check against DeepSeek settle it.
          for (const token of [run.slice(0, TOKEN_LENGTH), run]) {
            if (token.length >= 40 && !seen.has(token)) seen.add(token)
          }
        }
        at += needle.length
      }
    }
  }
  // The app's own token length first: a record's run can carry the next key's
  // first byte, and the 64-character token before it is the one the page wrote.
  return [...seen].sort((a, b) => Math.abs(a.length - TOKEN_LENGTH) - Math.abs(b.length - TOKEN_LENGTH))
}

// tokenFromLevelDb is the first candidate, what a caller that only wants one gets.
function tokenFromLevelDb(dir) {
  return tokenCandidatesFromLevelDb(dir)[0] ?? null
}

// findBrowserToken walks every readable browser profile and returns the first
// chat.deepseek.com token it finds, with where it came from.
function findBrowserToken() {
  for (const dir of chromiumRoots()) {
    const token = tokenFromLevelDb(dir)
    if (token) return { token, from: dir }
  }
  return null
}

// browserTokens lists every candidate a profile holds, newest profile first, so
// a sign-in can try each and keep the one DeepSeek accepts.
function browserTokens() {
  const out = []
  for (const dir of chromiumRoots()) {
    for (const token of tokenCandidatesFromLevelDb(dir)) out.push({ token, from: dir })
  }
  return out
}

// whoAmI asks the web app's own account endpoint whether a token is a live
// session. It is the cheapest call that answers it (no PoW, no chat). DeepSeek
// refuses a dead token inside the envelope with HTTP 200, so the business code
// is what decides it.
async function whoAmI(origin, token, signal) {
  const response = await fetch(`${origin}/api/v0/users/current`, {
    method: "GET",
    headers: headers(origin, token),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (response.status === 401 || response.status === 403) return null
  const value = await response.json().catch(() => null)
  if (!value || typeof value !== "object") return null
  const data = value.data
  const code = data?.biz_code ?? value.code
  if (code !== undefined && code !== null && code !== 0 && code !== "0") return null
  const biz = data?.biz_data ?? data ?? value
  if (!biz || typeof biz !== "object") return null
  const user = biz.user ?? biz
  const name = user?.email || user?.name || user?.mobile_number || user?.id || ""
  return { name: typeof name === "string" ? name : "" }
}

// findLiveBrowserToken is what the sign-in uses: the candidates in a browser
// profile, asked which one is still signed in.
async function findLiveBrowserToken(origin, signal) {
  const candidates = browserTokens()
  for (const candidate of candidates) {
    try {
      const who = await whoAmI(origin, candidate.token, signal)
      if (who) return { ...candidate, who }
    } catch {
      // try the next one
    }
  }
  return null
}

export {
  browserDataDirs,
  profileDirs,
  chromiumRoots,
  tokenCandidatesFromLevelDb,
  tokenFromLevelDb,
  findBrowserToken,
  browserTokens,
  whoAmI,
  findLiveBrowserToken,
}
