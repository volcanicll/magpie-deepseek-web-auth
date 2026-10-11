// Tool calling over a prompt
//
// The web app's completion has no `tools` field, so a client's tools are
// bridged at the prompt: the turn's prompt opens with the protocol below,
// teaching the model to end its reply with
//
//   <tool_call>{"name":"tool name","arguments":{...}}</tool_call>
//
// and the reply's blocks are parsed back into OpenAI `tool_calls` deltas (the
// streaming scan itself lives in the PatchReader, alongside the DSML filter it
// shares a text channel with). Tool results come back as `tool` role messages
// and are rendered as `Tool result (name): …` on the next turn.

const TOOL_CALL_OPEN = "<tool_call>"
const TOOL_CALL_SHUT = "</tool_call>"
// A block that accumulates more than this without closing is given up as
// broken rather than swallowing the rest of the reply.
const TOOL_RUNAWAY = 65_536

// toolsToPrompt is the protocol block a turn with tools opens its prompt
// with: one JSON line per tool, the call shape, and the house rules.
function toolsToPrompt(tools) {
  const list = (tools ?? [])
    .filter((tool) => typeof tool?.function?.name === "string")
    .map((tool) =>
      JSON.stringify({
        name: tool.function.name,
        description: typeof tool.function.description === "string" ? tool.function.description : "",
        parameters: tool.function.parameters ?? {},
      }),
    )
  if (!list.length) return ""
  return [
    "[Tool calling]",
    "You can call the tools listed at the end of this block. To call one, end your reply with a line of exactly this shape:",
    '<tool_call>{"name":"tool name","arguments":{}}</tool_call>',
    '- "arguments" carries the tool\'s parameters as JSON, following its schema.',
    "You may output several <tool_call> blocks in one reply to call tools in parallel.",
    "Do not wrap a call in code fences, and write nothing after the calls: their results arrive with the next turn.",
    "When no tool fits, answer normally and call nothing.",
    "The tools:",
    ...list,
  ].join("\n")
}

// renderToolCall draws one call as the model's own markup, for a history that
// shows the model what it called and how.
function renderToolCall(name, args) {
  return `${TOOL_CALL_OPEN}{"name":${JSON.stringify(name)},"arguments":${args}}${TOOL_CALL_SHUT}`
}

// parseToolCall reads one block's inner text into a call: {id, name,
// arguments}, with the arguments as the JSON string OpenAI carries. A block
// the model wrapped in a code fence is unwrapped first; anything that does not
// parse comes back null and the caller keeps it out of the reply.
function parseToolCall(inner) {
  let text = inner.trim()
  const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/)
  if (fence) text = fence[1].trim()
  if (!text) return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const name = typeof value?.name === "string" ? value.name.trim() : ""
  if (!name) return null
  const args = value?.arguments
  return {
    id: `call_${Math.random().toString(36).slice(2, 12)}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  }
}

export { TOOL_CALL_OPEN, TOOL_CALL_SHUT, TOOL_RUNAWAY, toolsToPrompt, renderToolCall, parseToolCall }
