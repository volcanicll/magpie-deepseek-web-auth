// A fake chat.deepseek.com: the endpoints and the SSE patch stream the plugin
// talks to, so its fetch is exercised without an account.
import { createServer } from "node:http"
import { deepSeekHashV1, powPrefix } from "./pow.mjs"

export const DIFFICULTY = 32

// The challenges the fake hands out, by target path.
export function makeChallenge(salt, expireAt, difficulty = DIFFICULTY) {
  return {
    algorithm: "DeepSeekHashV1",
    challenge: deepSeekHashV1(`${powPrefix({ salt, expireAt })}${difficulty % 7}`),
    salt,
    difficulty,
    expire_at: expireAt,
    signature: "fake-signature",
  }
}

const json = (res, value, status = 200) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

const envelope = (biz) => ({ code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: biz } })

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

// start brings up the fake and returns what to point the plugin's host at.
export async function start({ reply = "Hello", thinking = "", status = "FINISHED", fragmentType = "RESPONSE", usage = 12 } = {}) {
  const seen = { challenges: [], sessions: [], completions: [], headers: [], deletions: [] }
  let saltCounter = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    seen.headers.push({ path: url.pathname, headers: req.headers })
    if (url.pathname === "/api/v0/chat/create_pow_challenge") {
      const { target_path } = await body(req)
      seen.challenges.push({ targetPath: target_path })
      // DeepSeek only issues a challenge for the completion path.
      if (target_path !== "/api/v0/chat/completion") {
        return json(res, { code: 0, msg: "", data: { biz_code: 1, biz_msg: "INVALID_TARGET_PATH", biz_data: null } })
      }
      const challenge = makeChallenge(`salt${saltCounter++}`, 1791638192759)
      return json(res, envelope({ challenge: { ...challenge, target_path } }))
    }
    if (url.pathname === "/api/v0/chat_session/delete") {
      const { chat_session_id } = await body(req)
      seen.deletions.push(chat_session_id)
      seen.sessions = seen.sessions.filter((id) => id !== chat_session_id)
      return json(res, { code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: null } })
    }
    if (url.pathname === "/api/v0/users/current") {
      // The account endpoint a token is checked against. A token the fake does
      // not know is refused, as DeepSeek refuses a dead one.
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "")
      if (!token || token === "bad-token") return json(res, { code: 40003, msg: "Authorization Failed (invalid token)", data: null })
      return json(res, envelope({ id: "user-1", email: "tester@example.com", mobile_number: "176****" }))
    }
    if (url.pathname === "/api/v0/chat_session/create") {
      const id = `session-${seen.sessions.length + 1}`
      seen.sessions.push(id)
      return json(res, envelope({ chat_session: { id } }))
    }
    if (url.pathname === "/api/v0/chat/completion" || url.pathname === "/api/v0/chat/continue") {
      const payload = await body(req)
      seen.completions.push({ path: url.pathname, payload, pow: req.headers["x-ds-pow-response"] })
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      res.write(`event: ready\ndata: ${JSON.stringify({ request_message_id: 1, response_message_id: 2, model_type: payload.model_type })}\n\n`)
      const continuing = url.pathname === "/api/v0/chat/continue"
      // A turn that will stop unfinished has only its opening text so far; the
      // continuation carries the rest.
      if (!continuing) {
        res.write(`data: ${JSON.stringify({ v: { response: { message_id: 2, status: "WIP", thinking_enabled: false, accumulated_token_usage: 0, fragments: [{ id: 2, type: fragmentType, content: reply.slice(0, 1) }] } } })}\n\n`)
        if (thinking) res.write(`data: ${JSON.stringify({ p: "response/fragments/-1", o: "APPEND", v: thinking })}\n\n`)
        if (status !== "INCOMPLETE") res.write(`data: ${JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: reply.slice(1) })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: reply.slice(1) })}\n\n`)
      }
      const finalStatus = status === "INCOMPLETE" && !continuing ? "INCOMPLETE" : "FINISHED"
      res.write(`data: ${JSON.stringify({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: usage }, { p: "quasi_status", v: finalStatus }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ p: "response/status", o: "SET", v: finalStatus })}\n\n`)
      res.write(`event: close\ndata: ${JSON.stringify({ click_behavior: "none", auto_resume: false })}\n\n`)
      res.end()
      return
    }
    return json(res, { code: 404, msg: "not found", data: null }, 404)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

// streamText runs a plugin fetch and folds its SSE back into one string.
export async function streamText(response, { reasoning = false } = {}) {
  const text = await response.text()
  let content = ""
  let thoughts = ""
  let finish = null
  let usage = null
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6)
    if (payload === "[DONE]") continue
    const frame = JSON.parse(payload)
    if (frame.error) throw new Error(frame.error.message)
    const choice = frame.choices?.[0]
    if (choice) {
      content += choice.delta?.content ?? ""
      thoughts += choice.delta?.reasoning_content ?? ""
      if (choice.finish_reason) finish = choice.finish_reason
    }
    if (frame.usage) usage = frame.usage
  }
  return reasoning ? { content, thoughts, finish, usage, raw: text } : { content, finish, usage, raw: text }
}
