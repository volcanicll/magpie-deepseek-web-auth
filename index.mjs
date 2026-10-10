// DeepSeek (chat.deepseek.com) as an OpenCode/magpie provider plugin.
//
// The account is the one the user is already signed in to in their browser:
// chat.deepseek.com keeps its bearer token in localStorage's `userToken`, so the
// sign-in reads that token out of a signed-in browser profile (or takes it
// pasted) and replays it. Requests go to the web app's own API, which the
// browser and this plugin both use:
//
//   POST /api/v0/chat_session/create   a chat to talk in
//   POST /api/v0/chat/create_pow_challenge
//                                      a proof of work to answer first
//   POST /api/v0/chat/completion       the turn, answered as SSE patches
//
// Everything is the web app's contract, not DeepSeek's OpenAI-compatible
// platform API (api.deepseek.com, which takes a pay-as-you-go key): the account
// is a chat.deepseek.com session, so it is used the way the chat page uses it,
// with the same headers, the same PoW (pow.mjs) and the same SSE. Models are
// the two the page offers, `default` (DeepSeek-V3 chat) and `expert` (the
// reasoning model), thinking on or off per request as the page's toggle does.
//
// A turn streams and may be cut off unfinished: the plugin then asks DeepSeek
// to carry on (`/api/v0/chat/continue`) so the reply arrives whole, which is
// what the page does when its own stream stops.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { solvePow, powHeader } from "./pow.mjs"

const PROVIDER = "deepseek-web"
const NAME = "DeepSeek (chat.deepseek.com)"
const DEFAULT_ORIGIN = "https://chat.deepseek.com"
const NPM = "@ai-sdk/openai-compatible"

// The page's own headers, as the web client sends them.
const APP_VERSION = "2.4.0"

const MODELS = [
  {
    id: "deepseek-chat",
    wire: "default",
    name: "DeepSeek Chat",
    thinking: "off",
    context: 128_000,
    output: 8_192,
  },
  {
    id: "deepseek-reasoner",
    wire: "expert",
    name: "DeepSeek Reasoner",
    thinking: "on",
    context: 128_000,
    output: 32_768,
  },
]

const CHAT_PATHS = {
  "/chat/completions": "chat",
}

// ---------------------------------------------------------------------------
// browser profiles
//
// The sign-in looks for a signed-in chat.deepseek.com session in the browsers
// whose local storage can be read on this machine. Chromium keeps Local Storage
// in a leveldb under the profile; a small UTF-16 scan of it finds the
// `userToken` entry the page wrote, which is what a sign-in here needs. The
// browsers are read, never written, and nothing but the token is taken.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// the web API
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function headers(origin, token, extra = {}) {
  return {
    accept: "*/*",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin,
    referer: `${origin}/a/chat/`,
    "x-client-platform": "web",
    "x-client-version": APP_VERSION,
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-locale": "en_US",
    ...extra,
  }
}

// envelope unwraps DeepSeek's {code, msg, data: {biz_code, biz_msg, biz_data}}
// answer, as its own web client does, and takes the payload out.
function envelope(value, what, { allow = [] } = {}) {
  if (!value || typeof value !== "object") throw new Error(`DeepSeek ${what}: unexpected answer`)
  const data = value.data
  const code = data?.biz_code ?? value.code
  const message = data?.biz_msg || value.msg || ""
  const ok = code === undefined || code === null || code === 0 || code === "0" || allow.includes(Number(code))
  if (!ok) {
    const error = new Error(`DeepSeek ${what} refused (${code}): ${message || "no reason given"}`)
    error.code = Number(code)
    throw error
  }
  return data?.biz_data ?? null
}

async function json(response, what, options) {
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`DeepSeek ${what}: HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`DeepSeek ${what}: the sign-in was refused — sign in to chat.deepseek.com again`)
    error.signIn = "expired"
    throw error
  }
  if (!response.ok) throw new Error(`DeepSeek ${what}: HTTP ${response.status} ${text.slice(0, 200)}`)
  return envelope(value, what, options)
}

async function challenge(origin, token, targetPath, signal) {
  const response = await fetch(`${origin}/api/v0/chat/create_pow_challenge`, {
    method: "POST",
    headers: headers(origin, token),
    body: JSON.stringify({ target_path: targetPath }),
    signal,
  })
  const biz = await json(response, "proof-of-work challenge")
  const c = biz?.challenge
  if (!c || typeof c.challenge !== "string") throw new Error("DeepSeek proof-of-work challenge: none returned")
  return {
    algorithm: c.algorithm,
    challenge: c.challenge,
    salt: c.salt,
    difficulty: c.difficulty,
    expireAt: c.expire_at,
    signature: c.signature,
    targetPath: c.target_path ?? targetPath,
  }
}

async function createSession(origin, token, signal) {
  const response = await fetch(`${origin}/api/v0/chat_session/create`, {
    method: "POST",
    headers: headers(origin, token),
    body: JSON.stringify({}),
    signal,
  })
  const biz = await json(response, "chat session")
  const id = biz?.chat_session?.id ?? biz?.id
  if (!id) throw new Error("DeepSeek chat session: no id returned")
  return id
}

// deleteSession removes a chat the page would not keep. It takes no proof of
// work (DeepSeek answers INVALID_TARGET_PATH to a challenge naming it).
async function deleteSession(origin, token, sessionId, signal) {
  try {
    await fetch(`${origin}/api/v0/chat_session/delete`, {
      method: "POST",
      headers: headers(origin, token),
      body: JSON.stringify({ chat_session_id: sessionId }),
      signal,
    })
  } catch {
    // a delete that fails leaves a stray chat behind, nothing worse
  }
}

// Magpie names every conversation with a title request before it shows one in
// its list: one user message that carries the instructions and the turn to
// summarise. It is not part of the conversation — answering it inside the
// conversation's own chat would file the instructions there and a fresh chat
// per message besides — so these are served from a chat of their own that is
// deleted as soon as the title is in.
// Both phrases are magpie's own instructions, verbatim in every title request;
// a user's question that merely mentions titles does not carry them both.
const TITLE_MARKERS = [/generate a concise title for this/i, /return exactly one valid json object/i]

function isTitleRequest(messages) {
  const text = messages?.filter((m) => m?.role === "user").map((m) => (typeof m?.content === "string" ? m.content : "")).join("\n") ?? ""
  return TITLE_MARKERS.every((marker) => marker.test(text))
}

// ---------------------------------------------------------------------------
// the reply stream
//
// The completion answers with SSE: `event: ready`, then `data:` frames that are
// JSON patches into the reply object. Text arrives either as a whole fragment
// (`{"v":{"response":{…"fragments":[{"type":"RESPONSE","content":"…"}]}}}`) or as
// an append to one (`{"p":"response/fragments/-1/content","o":"APPEND","v":"…"}`),
// and THINKING fragments carry the reasoning. `event: close` ends a turn, with
// the reply's status in it — INCOMPLETE means DeepSeek stopped early and the
// page asks it to continue.
// ---------------------------------------------------------------------------

class PatchReader {
  constructor() {
    this.text = ""
    this.reasoning = ""
    this.messageId = null
    this.status = null
    this.closed = false
    this.usage = null
    this.lastKind = "RESPONSE" // what a patch to fragment -1 (the last one) belongs to
  }

  // apply folds one patch frame into the reply's text. The page's stream uses
  // three shapes:
  //   {"v":{"response":{…}}}                    a whole reply, or one pushed whole
  //   {"p":"response/fragments/-1/content", …}  a patch addressed by path
  //   {"v":"UG"}                                text appended to the last fragment
  apply(frame) {
    if (!frame || typeof frame !== "object") return
    // A path-addressed patch comes first: its value is often a bare string too
    // ("response/status" → SET "FINISHED"), which must not read as text.
    if (frame.p && typeof frame.p === "string") {
      this.patch(frame.p, frame.o, frame.v)
      return
    }
    if (typeof frame.v === "string") {
      // A bare string is an append to the fragment being written.
      this.append(this.lastKind, frame.v)
      return
    }
    if (frame.v && typeof frame.v === "object") this.tree(frame.v)
  }

  tree(value) {
    const response = value.response ?? value.v?.response
    if (response && typeof response === "object") {
      if (typeof response.message_id === "number") this.messageId = response.message_id
      if (typeof response.status === "string") this.status = response.status
      if (typeof response.accumulated_token_usage === "number") this.usage = response.accumulated_token_usage
      this.fragments(response.fragments)
    }
    // A patch's own value can be a response part ("response/status" → SET "FINISHED")
    for (const [key, v] of Object.entries(value)) {
      if (key === "response") continue
      if (key === "status" && typeof v === "string") this.status = v
      if (key === "message_id" && typeof v === "number") this.messageId = v
    }
  }

  // fragments records each fragment's kind and folds in the text it carries.
  fragments(list) {
    if (!Array.isArray(list)) return
    for (const fragment of list) {
      if (!fragment || typeof fragment !== "object") continue
      if (fragment.type) this.lastKind = fragment.type
      if (typeof fragment.content === "string") this.append(fragment.type, fragment.content)
    }
  }

  patch(path, op, value) {
    if (/^response\/status$/.test(path) && typeof value === "string") this.status = value
    if (/^response\/message_id$/.test(path) && typeof value === "number") this.messageId = value
    if (/accumulated_token_usage/.test(path) && typeof value === "number") this.usage = value
    // Appending a whole fragment moves the "last fragment" the bare {"v":"…"}
    // frames land in — the expert model opens its answer this way.
    if (/^response\/fragments$/.test(path) && Array.isArray(value)) return this.fragments(value)
    if (/^response\/fragments\/-1\//.test(path) && typeof value === "string" && (op === "APPEND" || op === "SET" || op === undefined)) {
      this.append(this.lastKind, value)
    }
    // A BATCH carries several patches of the same shape.
    if (op === "BATCH" && Array.isArray(value)) for (const item of value) this.apply(item)
    // A fragment pushed whole arrives as an object rather than a patch op.
    if (value && typeof value === "object" && Array.isArray(value.fragments)) this.fragments(value.fragments)
  }

  append(type, content) {
    if (!content) return
    const kind = String(type ?? "").toUpperCase()
    if (kind === "THINK" || kind === "THINKING" || kind === "REASONING" || kind === "SEARCH" || kind === "TOOL_SEARCH" || kind === "TOOL_OPEN" || kind === "TOOL_FIND") {
      this.reasoning += content
    } else if (kind === "RESPONSE" || kind === "TEMPLATE_RESPONSE" || !kind) {
      this.text += content
    }
  }
}

// iterSse reads `data:` JSON frames off a fetch body, keeping the `event` name
// each one carries.
async function* iterSse(body) {
  const decoder = new TextDecoder()
  let buffer = ""
  let event = "message"
  const pending = []
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (!line) {
        if (pending.length) {
          const data = pending.join("\n")
          pending.length = 0
          if (data.trim() !== "[DONE]") {
            try {
              yield { event, data: JSON.parse(data) }
            } catch {
              // a frame that isn't JSON is the page's business, not ours
            }
          }
        }
        event = "message"
        continue
      }
      if (line.startsWith(":")) continue
      const colon = line.indexOf(":")
      if (colon === -1) continue
      const field = line.slice(0, colon)
      let value = line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "event") event = value || "message"
      else if (field === "data") pending.push(value)
    }
  }
  if (pending.length) {
    try {
      yield { event, data: JSON.parse(pending.join("\n")) }
    } catch {
      // ignore a trailing partial frame
    }
  }
}

// ---------------------------------------------------------------------------
// the OpenAI-shaped answer
//
// magpie's SDK talks OpenAI chat completions to a plugin's fetch, so the web
// app's patches are translated back into that shape: one choice, `delta.content`
// for the reply and `delta.reasoning_content` for the thinking, then a
// `finish_reason` and a `usage`.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

function chunk(id, created, model, delta, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`
}

function finishReason(status) {
  switch (status) {
    case "FINISHED":
      return "stop"
    case "CONTENT_FILTER":
      return "content_filter"
    case "CONTEXT_LENGTH_EXCEEDED":
      return "length"
    case "INCOMPLETE":
      return "length"
    case "TIMEOUT":
      return "length"
    default:
      return "stop"
  }
}

// messagesToPrompt flattens OpenAI messages into DeepSeek's single prompt, as
// the web page's one text box holds a conversation. With `from`, the turns
// before it are left out: the web app's session remembers what it has said, so
// a follow-up sends only what is new, and the first new turn reads as the
// prompt rather than as a quoted "User: …". The full history is labelled —
// system text whole, then each turn after the first — for a conversation that
// starts over.
function messagesToPrompt(messages, from = 0) {
  const parts = []
  let spoke = false
  const list = messages ?? []
  let index = Math.max(0, from)
  // The agent's history re-sends its own last reply before the new user turn —
  // an assistant message DeepSeek's session already holds — so leading
  // assistant or tool messages at `from` are skipped: what is left is the turn
  // the session has not seen.
  while (index < list.length && (list[index]?.role === "assistant" || list[index]?.role === "tool")) index += 1
  for (; index < list.length; index++) {
    const message = list[index]
    const role = message?.role
    const text = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
        : ""
    if (!text) continue
    if (role === "system") parts.push(text)
    else if (role === "assistant") parts.push(`Assistant: ${text}`)
    else if (role === "tool") parts.push(`Tool result: ${text}`)
    else if (spoke) parts.push(`User: ${text}`)
    else parts.push(text)
    if (role !== "system") spoke = true
  }
  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// the plugin
// ---------------------------------------------------------------------------

function modelOf(model) {
  return {
    name: model.name,
    reasoning: model.thinking === "on",
    tool_call: false,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: model.context, output: model.output },
    cost: { input: 0, output: 0 },
  }
}

function configModels() {
  return Object.fromEntries(MODELS.map((model) => [model.id, modelOf(model)]))
}

// runTurn sends one prompt and streams the page's answer, asking DeepSeek to
// continue when it stops the reply unfinished — which its own page does too.
// A turn either opens a session of its own (`sessionId` null) or carries on an
// existing one: the web app remembers what its session has said, so a carried-on
// turn sends only the new prompt, and `parent_message_id` chains the reply to
// the turn before it, as the page does when you keep typing in one chat.
// Returns { sessionId, messageId }: the chat the turn used (opening one when it
// was given none) and the reply's message id, what the next turn chains to.
async function* runTurn({ origin, token, model, prompt, thinking, signal, sessionId = null, parentMessageId = null }) {
  const chatSessionId = sessionId ?? (await createSession(origin, token, signal))
  const reader = new PatchReader()
  let continues = 0
  const maxContinues = 20
  let endpoint = "/api/v0/chat/completion"
  let payload = {
    action: null,
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    model_type: model.wire,
    prompt,
    ref_file_ids: [],
    thinking_enabled: thinking,
    search_enabled: false,
    preempt: false,
  }
  for (;;) {
    // Only /api/v0/chat/completion takes a proof of work: DeepSeek answers
    // INVALID_TARGET_PATH for a challenge naming /chat/continue or
    // /chat/resume_stream, and those two are sent with no x-ds-pow-response.
    const fresh = endpoint === "/api/v0/chat/completion"
    const headersFor = async () => {
      const base = headers(origin, token)
      if (!fresh) return base
      const pow = await challenge(origin, token, endpoint, signal)
      const answer = solvePow(pow, { signal })
      return headers(origin, token, { "x-ds-pow-response": powHeader(pow, answer, { targetPath: endpoint }) })
    }
    const response = await fetch(`${origin}${endpoint}`, {
      method: "POST",
      headers: await headersFor(),
      body: JSON.stringify(payload),
      signal,
    })
    if (response.status === 401 || response.status === 403) {
      const error = new Error("DeepSeek: the sign-in was refused — sign in to chat.deepseek.com again")
      error.signIn = "expired"
      throw error
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      // A resumed stream can answer the whole message at once (biz_code 22).
      const biz = await json(response, "completion", { allow: [22] })
      if (biz?.response) {
        reader.apply({ v: { response: biz.response } })
        yield reader
        return { sessionId: chatSessionId, messageId: reader.messageId }
      }
      throw new Error(`DeepSeek completion: expected a stream, got ${contentType || "no content type"}`)
    }
    reader.status = null
    reader.closed = false
    for await (const { event, data } of iterSse(response.body)) {
      if (event === "close") {
        reader.closed = true
        break
      }
      if (event !== "message" && event !== "ready") continue
      reader.apply(data)
      yield reader
    }
    if (reader.status === "FINISHED" && !reader.text && !reader.reasoning && reader.messageId !== null && continues === 0) {
      // An empty but finished reply: the page re-reads the stream for it. A
      // reply that only thought is not empty — the page shows it as it is.
      continues += 1
      endpoint = "/api/v0/chat/resume_stream"
      payload = { chat_session_id: chatSessionId, message_id: reader.messageId }
      continue
    }
    if (reader.status === "INCOMPLETE" && reader.messageId !== null && continues < maxContinues) {
      continues += 1
      endpoint = "/api/v0/chat/continue"
      payload = { chat_session_id: chatSessionId, message_id: reader.messageId, fallback_to_resume: true }
      continue
    }
    // The chat the turn used and the reply's own message id, what the next
    // turn in this conversation chains to.
    return { sessionId: chatSessionId, messageId: reader.messageId }
  }
}

export const server = async (_input, _options) => {
  const origin = _options?.origin ?? DEFAULT_ORIGIN
  const DEEPSEEK = {
    name: NAME,
    npm: NPM,
    api: origin,
    models: configModels(),
  }
  // One DeepSeek chat per conversation the agent is having: agent session →
  // the chat session it opened, the reply to chain the next turn to, how many
  // turns of the agent's history that chat already holds, and when it was last
  // used. Sessions idle past the TTL are dropped, so a day-old thread starts a
  // fresh chat rather than holding DeepSeek to one that may be gone.
  const sessions = new Map()
  const SESSION_TTL = 6 * 3600 * 1000
  return {
    config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= DEEPSEEK
    },
    // magpie's own hook: the agent's session id rides in here, which is what
    // keeps one agent conversation on one DeepSeek chat. OpenCode ignores it.
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.model?.providerID !== `${PROVIDER}-plugin`) return
      if (!input.sessionID) return
      output.headers["x-magpie-session"] = input.sessionID
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "Sign in with the browser (chat.deepseek.com)",
          // The browser sign-in is a lookup, not a redirect: it reads the token
          // the page already wrote into a signed-in profile. The host still
          // wants the {url, instructions, method, callback} envelope an oauth
          // method returns, so the work happens in callback and "auto" says
          // nothing needs typing.
          async authorize() {
            return {
              url: `${origin}/a/chat/`,
              instructions:
                "Reading the chat.deepseek.com token from this machine's browsers; " +
                "if none is signed in, sign in there in Chrome, Edge, Brave or Chromium and run this again.",
              method: "auto",
              async callback() {
                let found = null
                try {
                  found = await findLiveBrowserToken(origin)
                } catch {
                  found = null
                }
                if (!found) {
                  const any = findBrowserToken()
                  return {
                    type: "failed",
                    error: any
                      ? "A chat.deepseek.com token was found in this machine's browsers, but DeepSeek refused it — " +
                        "the sign-in there has lapsed. Open https://chat.deepseek.com, sign in, then try again."
                      : "No signed-in chat.deepseek.com session was found in this machine's browsers. " +
                        "Sign in to https://chat.deepseek.com in Chrome, Edge, Brave or Chromium, then try again — " +
                        "or use the paste sign-in.",
                  }
                }
                return {
                  type: "success",
                  access: found.token,
                  // chat.deepseek.com's session token is long-lived; it is
                  // either replaced by a new sign-in or refused, never
                  // refreshed by us.
                  refresh: "",
                  expires: Date.now() + 365 * 24 * 3600 * 1000,
                  accountId: found.who?.name || accountLabel(found.token),
                  name: found.who?.name || undefined,
                  metadata: { source: found.from },
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste a chat.deepseek.com token",
          placeholder: "userToken",
          // The host hands an api method's answered prompts, not the key: the
          // key is given to the sign-in separately and saved from there. So
          // there is nothing to check here unless a caller passed the token in
          // as an input (OpenCode's TUI does); otherwise the loader checks it
          // on the first request and says so.
          async authorize(inputs) {
            const token = String(inputs?.token ?? inputs?.key ?? "").trim()
            if (!token) return { type: "success", metadata: { source: "pasted" } }
            const who = await whoAmI(origin, token).catch(() => null)
            if (!who) {
              return {
                type: "failed",
                error:
                  "DeepSeek refused that token — copy userToken's value from a signed-in " +
                  'chat.deepseek.com tab (JSON.parse(localStorage.getItem("userToken")).value)',
              }
            }
            return {
              type: "success",
              key: token,
              accountId: who.name || accountLabel(token),
              metadata: { source: "pasted" },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const token = auth?.type === "oauth" ? auth.access : auth?.key
        if (!token) return {}
        // A pasted token is checked once here, when the host knows the account
        // but not whether the string is a live session: a typo should say so
        // rather than look like a model that fails every turn.
        if (auth?.type === "api") {
          const who = await whoAmI(origin, token).catch(() => null)
          if (!who) {
            const error = new Error(
              "DeepSeek refused this token — sign in again with a token copied from a " +
                'signed-in chat.deepseek.com tab (JSON.parse(localStorage.getItem("userToken")).value)',
            )
            error.signIn = "expired"
            throw error
          }
        }
        return {
          baseURL: origin,
          apiKey: token,
          // The host calls this as `fetch(url, init)` with a string URL (as
          // the AI SDK does); OpenCode may hand a Request instead. Accept both.
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            const url = new URL(request.url)
            if (!CHAT_PATHS[url.pathname] || request.method !== "POST") {
              throw new Error(`DeepSeek: unsupported request ${request.method} ${url.pathname}`)
            }
            const body = await request.json()
            const model = MODELS.find((m) => m.id === body.model)
            if (!model) throw new Error(`DeepSeek: unknown model ${JSON.stringify(body.model)}`)
            const fresh = await getAuth()
            const live = fresh?.type === "oauth" ? fresh.access : fresh?.key
            if (!live) throw new Error("DeepSeek: not signed in")
            const streaming = body.stream !== false
            const thinking = model.thinking === "on" || body.reasoning_effort === "high" || body.reasoning_effort === "medium"
            const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
            const created = Math.floor(Date.now() / 1000)

            // One DeepSeek chat per conversation the agent is having: the web
            // app's session remembers its turns, so turn N+1 sends only what is
            // new and chains to turn N's reply, the way the page does when you
            // keep typing in one chat. The agent's session id comes through
            // chat.headers; an agent that sends none gets one chat per request,
            // as before. A session DeepSeek no longer serves starts over with
            // the whole history, so the reply keeps its context.
            const sessionKey = request.headers.get("x-magpie-session") || `solo-${id}`
            const messages = body.messages ?? []
            // A title request is magpie's own housekeeping, not the
            // conversation: it is answered from a chat of its own that is
            // deleted when the title is in, and the conversation's mapping is
            // left exactly as it was.
            const titleRequest = isTitleRequest(messages)
            const known = sessions.get(sessionKey)
            let from = 0
            let deepseekSession = null
            let parentMessageId = null
            if (!titleRequest && known && known.sessionId && Date.now() - (known.at ?? 0) <= SESSION_TTL && known.count > 0 && known.count < messages.length) {
              deepseekSession = known.sessionId
              parentMessageId = known.messageId
              from = known.count
            }
            const prompt = messagesToPrompt(messages, from)
            if (!titleRequest && deepseekSession === null) sessions.delete(sessionKey)

            let last = null
            const stream = new ReadableStream({
              async start(controller) {
                let sent = 0
                let reasoningSent = 0
                let roleSent = false
                let failure = null
                let opened = deepseekSession
                let parentId = parentMessageId
                let usedSession = null
                // A reply DeepSeek turns away (its session was deleted, it was
                // renamed, it hit a limit) starts a new chat with the whole
                // history once, rather than failing the turn.
                for (const attempt of [0, 1]) {
                  failure = null
                  const turn = runTurn({
                    origin,
                    token: live,
                    model,
                    prompt: attempt === 0 ? prompt : messagesToPrompt(messages, 0),
                    thinking,
                    signal: request.signal,
                    sessionId: attempt === 0 ? opened : null,
                    parentMessageId: attempt === 0 ? parentId : null,
                  })
                  try {
                    // Driven by next() rather than for-await, so the turn's
                    // return — the chat it used and the reply to chain the next
                    // turn to — is read when the stream is done.
                    for (;;) {
                      const step = await turn.next()
                      if (step.done) {
                        const used = step.value
                        usedSession = used?.sessionId ?? null
                        if (used?.sessionId && !titleRequest) {
                          sessions.set(sessionKey, { sessionId: used.sessionId, messageId: used.messageId, count: messages.length, at: Date.now() })
                        }
                        break
                      }
                      const state = step.value
                      last = state
                      if (!roleSent) {
                        roleSent = true
                        controller.enqueue(encoder.encode(chunk(id, created, model.id, { role: "assistant", content: "" })))
                      }
                      if (state.reasoning.length > reasoningSent) {
                        const delta = state.reasoning.slice(reasoningSent)
                        reasoningSent = state.reasoning.length
                        controller.enqueue(encoder.encode(chunk(id, created, model.id, { reasoning_content: delta })))
                      }
                      if (state.text.length > sent) {
                        const delta = state.text.slice(sent)
                        sent = state.text.length
                        controller.enqueue(encoder.encode(chunk(id, created, model.id, { content: delta })))
                      }
                    }
                    break
                  } catch (error) {
                    failure = error
                    if (attempt === 0 && error?.code === 40003) {
                      // The session went away: start a new chat with the whole
                      // history, once.
                      opened = null
                      parentId = null
                      sent = 0
                      reasoningSent = 0
                      roleSent = false
                      last = null
                      continue
                    }
                    break
                  }
                }
                if (failure) {
                  // A title chat that failed still goes: it was only opened to
                  // be thrown away.
                  if (titleRequest && usedSession) await deleteSession(origin, live, usedSession)
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: failure.message ?? String(failure), type: "upstream_error" } })}\n\n`))
                  controller.close()
                  return
                }
                // A title chat is deleted as soon as its title is in: it is not
                // the conversation's chat and the account should not keep it.
                // Awaited, so the reply arriving means the chat is already gone.
                if (titleRequest && usedSession) await deleteSession(origin, live, usedSession)
                controller.enqueue(encoder.encode(chunk(id, created, model.id, {}, finishReason(last?.status))))
                if (last?.usage) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: model.id, choices: [], usage: { prompt_tokens: 0, completion_tokens: last.usage, total_tokens: last.usage } })}\n\n`))
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                controller.close()
              },
            })
            const headersOut = new Headers()
            headersOut.set("content-type", "text/event-stream; charset=utf-8")
            headersOut.set("cache-control", "no-cache")
            if (!streaming) {
              // A caller that asked for one answer gets the stream folded up.
              const collected = await new Response(stream).text()
              let text = ""
              let reasoning = ""
              let finish = "stop"
              for (const line of collected.split("\n")) {
                if (!line.startsWith("data: ")) continue
                const payload = line.slice(6)
                if (payload === "[DONE]") continue
                let frame
                try {
                  frame = JSON.parse(payload)
                } catch {
                  continue
                }
                const choice = frame.choices?.[0]
                text += choice?.delta?.content ?? ""
                reasoning += choice?.delta?.reasoning_content ?? ""
                if (choice?.finish_reason) finish = choice.finish_reason
              }
              const message = { role: "assistant", content: text }
              if (reasoning) message.reasoning_content = reasoning
              return new Response(
                JSON.stringify({
                  id,
                  object: "chat.completion",
                  created,
                  model: model.id,
                  choices: [{ index: 0, message, finish_reason: finish }],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            }
            return new Response(stream, { status: 200, headers: headersOut })
          },
        }
      },
    },
    async usage() {
      // The web app exposes no allowance to read; the account's own page does.
      return { plan: "DeepSeek (web)", windows: [] }
    },
    provider: {
      id: PROVIDER,
      async models(provider) {
        return provider.models
      },
    },
  }
}

function accountLabel(token) {
  return `chat.deepseek.com · ${token.slice(0, 6)}…`
}

export default { id: PROVIDER, server }

// for tests
export const _internal = {
  MODELS,
  PatchReader,
  iterSse,
  messagesToPrompt,
  findBrowserToken,
  findLiveBrowserToken,
  browserTokens,
  whoAmI,
  tokenFromLevelDb,
  tokenCandidatesFromLevelDb,
  chromiumRoots,
  envelope,
  finishReason,
}
