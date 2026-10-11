// The web app's own HTTP contract: the page's headers, the response envelope,
// the proof-of-work challenge and the chat session calls.

import { APP_VERSION } from "./config.mjs"

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

export {
  sleep,
  headers,
  envelope,
  json,
  challenge,
  createSession,
  deleteSession,
  isTitleRequest,
}
