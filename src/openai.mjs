// The OpenAI-shaped answer
//
// magpie's SDK talks OpenAI chat completions to a plugin's fetch, so the web
// app's patches are translated back into that shape: one choice, `delta.content`
// for the reply and `delta.reasoning_content` for the thinking, then a
// `finish_reason` and a `usage`.

import { toolsToPrompt, renderToolCall } from "./toolcall.mjs"

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
// starts over. With `tools`, the prompt opens with the tool-calling protocol,
// and the history shows the model its own calls and their results in that same
// markup.
function messagesToPrompt(messages, from = 0, { tools } = {}) {
  const parts = []
  const protocol = toolsToPrompt(tools)
  if (protocol) parts.push(protocol)
  let spoke = false
  const toolNames = new Map() // tool_call_id → the name the client called
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
    const calls = role === "assistant" && Array.isArray(message?.tool_calls) ? message.tool_calls : []
    for (const call of calls) {
      if (typeof call?.id === "string" && typeof call?.function?.name === "string") toolNames.set(call.id, call.function.name)
    }
    if (role === "system") {
      if (text) parts.push(text)
      continue
    }
    if (role === "assistant") {
      const block = calls
        .map((call) => {
          const fn = call?.function
          if (typeof fn?.name !== "string") return null
          const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {})
          return renderToolCall(fn.name, args)
        })
        .filter(Boolean)
        .join("\n")
      const body = [text, block].filter(Boolean).join("\n")
      if (body) parts.push(`Assistant: ${body}`)
      continue
    }
    if (role === "tool") {
      if (text) {
        const name = typeof message?.tool_call_id === "string" ? toolNames.get(message.tool_call_id) : null
        parts.push(`Tool result${name ? ` (${name})` : ""}: ${text}`)
      }
      continue
    }
    if (!text) continue
    if (spoke) parts.push(`User: ${text}`)
    else parts.push(text)
    spoke = true
  }
  return parts.join("\n\n")
}

export { encoder, chunk, finishReason, messagesToPrompt }
