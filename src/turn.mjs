// One turn against the page's completion endpoint: the proof of work, the SSE
// patch stream, and the continue/resume calls the page itself makes when the
// reply stops unfinished.

import { solvePow, powHeader } from "./pow.mjs"
import { headers, json, challenge, createSession } from "./api.mjs"
import { PatchReader, iterSse } from "./stream.mjs"

async function* runTurn({ origin, token, model, prompt, thinking, search, refFileIds = [], tools = false, signal, sessionId = null, parentMessageId = null }) {
  const chatSessionId = sessionId ?? (await createSession(origin, token, signal))
  const reader = new PatchReader({ tools })
  let continues = 0
  const maxContinues = 20
  let endpoint = "/api/v0/chat/completion"
  const attached = refFileIds.length > 0
  let payload = {
    action: null,
    chat_session_id: chatSessionId,
    parent_message_id: parentMessageId,
    model_type: attached ? "default" : model.wire,
    prompt,
    ref_file_ids: refFileIds,
    thinking_enabled: attached ? false : thinking,
    search_enabled: search,
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
        reader.flushHold()
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
    // The stream is done: what a split tag left held is put out before the
    // turn's state is read.
    reader.flushHold()
    if (reader.status === "FINISHED" && !reader.text && !reader.reasoning && reader.toolCalls.length === 0 && reader.messageId !== null && continues === 0) {
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

export { runTurn }
