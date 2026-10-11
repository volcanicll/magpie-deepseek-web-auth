// The reply stream
//
// The completion answers with SSE: `event: ready`, then `data:` frames that are
// JSON patches into the reply object. Text arrives either as a whole fragment
// (`{"v":{"response":{…"fragments":[{"type":"RESPONSE","content":"…"}]}}}`) or as
// an append to one (`{"p":"response/fragments/-1/content","o":"APPEND","v":"…"}`),
// and THINKING fragments carry the reasoning. `event: close` ends a turn, with
// the reply's status in it — INCOMPLETE means DeepSeek stopped early and the
// page asks it to continue.

import { TOOL_CALL_OPEN, TOOL_CALL_SHUT, TOOL_RUNAWAY, parseToolCall, parseDsmlCalls } from "./toolcall.mjs"

// The DSML tool-call markup the web models write for their built-in agent
// tools, as the page's own client renders it: tags open with <｜｜DSML and
// close with </｜｜DSML, both running to the next ">".
const DSML_OPEN = "<｜｜DSML"
const DSML_SHUT = "</｜｜DSML"
// A block that swallows more than this without closing is treated as broken:
// the rest of the reply flows as text again rather than into the reasoning.
const DSML_RUNAWAY = 65_536

// tailHold is the length of the longest tail of s that could still grow into
// one of the markers, 0 when none could.
function tailHold(s, markers) {
  const longest = Math.max(...markers.map((marker) => marker.length)) - 1
  for (let n = Math.min(s.length, longest); n > 0; n--) {
    const tail = s.slice(-n)
    if (markers.some((marker) => marker.startsWith(tail))) return n
  }
  return 0
}

class PatchReader {
  constructor({ tools = false } = {}) {
    this.text = ""
    this.reasoning = ""
    this.messageId = null
    this.status = null
    this.closed = false
    this.usage = null
    this.lastKind = "RESPONSE" // what a patch to fragment -1 (the last one) belongs to
    // Two kinds of markup ride the reply's text channel and never belong in
    // it. The web models write tool calls in their own DSML markup — the
    // page's built-in agent format — and with tools on the turn those calls
    // are parsed into toolCalls (without tools they fold into the reasoning,
    // since there is nothing to execute them). The prompt-side protocol's
    // <tool_call> blocks parse the same way. A marker a delta cut in half is
    // held back until the rest of it arrives.
    this.tools = tools
    this.toolCalls = []
    this.block = null // null | "dsml" | "dsmltool" | "tool"
    this.mid = false // a DSML tag marker sits half-arrived at the hold
    this.hold = ""
    this.dsmlDepth = 0
    this.dsmlSeen = 0
    this.dsmlBuf = ""
    this.toolBuf = ""
  }

  // markers lists the block markers the plain-text channel watches for.
  get markers() {
    return this.tools ? [DSML_OPEN, DSML_SHUT, TOOL_CALL_OPEN, TOOL_CALL_SHUT] : [DSML_OPEN, DSML_SHUT]
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
      this.emitText(content)
    }
  }

  // emitText folds one piece of reply text, keeping markup out of the reply:
  // DSML blocks go to the reasoning, and with tools on the turn, <tool_call>
  // blocks are parsed into toolCalls. Only whole tags move the DSML nesting
  // count — a ">" inside a tag's value is just text — and a marker a delta cut
  // in half is held back until the rest of it arrives.
  emitText(content) {
    let buffer = this.hold + content
    this.hold = ""
    for (;;) {
      if (this.block === "dsml") {
        if (this.mid) {
          // a tag marker sits at the head: it runs to its ">"
          const end = buffer.indexOf(">")
          if (end === -1) {
            this.hold = buffer
            return
          }
          const tag = buffer.slice(0, end + 1)
          this.reasoning += tag
          this.dsmlSeen += tag.length
          buffer = buffer.slice(end + 1)
          this.mid = false
          this.dsmlDepth = Math.max(0, this.dsmlDepth + (tag.startsWith(DSML_SHUT) ? -1 : 1))
          if (this.dsmlDepth === 0) {
            this.block = null
            this.dsmlSeen = 0
          } else if (this.dsmlSeen > DSML_RUNAWAY) {
            // a block that never closes: let the rest through as text
            this.block = null
            this.dsmlDepth = 0
            this.dsmlSeen = 0
          }
          continue
        }
        // inside the block: everything is reasoning until the next tag marker
        const open = buffer.indexOf(DSML_OPEN)
        const shut = buffer.indexOf(DSML_SHUT)
        const at = shut === -1 ? open : open === -1 ? shut : Math.min(open, shut)
        if (at === -1) {
          const keep = tailHold(buffer, [DSML_OPEN, DSML_SHUT])
          if (keep) {
            this.reasoning += buffer.slice(0, buffer.length - keep)
            this.dsmlSeen += buffer.length - keep
            this.hold = buffer.slice(buffer.length - keep)
          } else {
            this.reasoning += buffer
            this.dsmlSeen += buffer.length
          }
          return
        }
        if (at > 0) {
          this.reasoning += buffer.slice(0, at)
          this.dsmlSeen += at
          buffer = buffer.slice(at)
        }
        this.mid = true
        continue
      }
      if (this.block === "dsmltool") {
        // with tools on, a DSML block is a tool call in the model's own
        // format: capture it whole, then parse the invokes out of it
        if (this.mid) {
          const end = buffer.indexOf(">")
          if (end === -1) {
            this.hold = buffer
            return
          }
          const tag = buffer.slice(0, end + 1)
          this.dsmlBuf += tag
          buffer = buffer.slice(end + 1)
          this.mid = false
          this.dsmlDepth += tag.startsWith(DSML_SHUT) ? -1 : 1
          if (this.dsmlDepth <= 0) {
            this.block = null
            const raw = this.dsmlBuf
            this.dsmlBuf = ""
            const calls = parseDsmlCalls(raw)
            if (calls.length) for (const call of calls) this.toolCalls.push(call)
            // nothing readable in it: back to the reasoning, never the reply
            else this.reasoning += raw
          }
          continue
        }
        const open = buffer.indexOf(DSML_OPEN)
        const shut = buffer.indexOf(DSML_SHUT)
        const at = shut === -1 ? open : open === -1 ? shut : Math.min(open, shut)
        if (at === -1) {
          const keep = tailHold(buffer, [DSML_OPEN, DSML_SHUT])
          if (keep) {
            this.dsmlBuf += buffer.slice(0, buffer.length - keep)
            this.hold = buffer.slice(buffer.length - keep)
          } else {
            this.dsmlBuf += buffer
          }
          return
        }
        if (at > 0) {
          this.dsmlBuf += buffer.slice(0, at)
          buffer = buffer.slice(at)
        }
        this.mid = true
        continue
      }
      if (this.block === "tool") {
        // the whole block is held until its closing tag: accumulate first,
        // then search — a tag split across deltas spans buffer and toolBuf
        this.toolBuf += buffer
        buffer = ""
        const shut = this.toolBuf.indexOf(TOOL_CALL_SHUT)
        if (shut === -1) {
          if (this.toolBuf.length > TOOL_RUNAWAY) {
            // a block that never closes: it was meant as markup, not reply —
            // give it to the reasoning and let the rest flow as text
            this.reasoning += this.toolBuf
            this.toolBuf = ""
            this.block = null
          }
          return
        }
        const inner = this.toolBuf.slice(0, shut)
        buffer = this.toolBuf.slice(shut + TOOL_CALL_SHUT.length)
        this.toolBuf = ""
        this.block = null
        const call = parseToolCall(inner)
        if (call) this.toolCalls.push(call)
        // a block that does not parse was the model reaching for a tool it
        // cannot have; it is shown in the reasoning, never in the reply
        else this.reasoning += `${TOOL_CALL_OPEN}${inner}${TOOL_CALL_SHUT}`
        continue
      }
      // plain text: find the earliest open marker. <tool_call> blocks are
      // unambiguous call intents and always parse; a DSML block is only a
      // tool call when the turn actually carries tools, and otherwise the
      // model's own business, kept in the reasoning.
      const dsmlAt = buffer.indexOf(DSML_OPEN)
      const toolAt = buffer.indexOf(TOOL_CALL_OPEN)
      const at = toolAt === -1 ? dsmlAt : dsmlAt === -1 ? toolAt : Math.min(dsmlAt, toolAt)
      if (at === -1) {
        const keep = tailHold(buffer, this.markers)
        if (keep) this.hold = buffer.slice(buffer.length - keep)
        const text = keep ? buffer.slice(0, buffer.length - keep) : buffer
        if (text) this.text += text
        return
      }
      if (at > 0) this.text += buffer.slice(0, at)
      buffer = buffer.slice(at)
      if (at === toolAt) {
        this.block = "tool"
        this.toolBuf = ""
        // the open marker is a fixed literal: consume it here, the block runs
        // to its closing tag
        buffer = buffer.slice(TOOL_CALL_OPEN.length)
        continue
      }
      // the opening tag itself is counted when it completes, below — and with
      // tools on the turn a DSML block is a tool call, not reasoning
      this.block = this.tools ? "dsmltool" : "dsml"
      this.dsmlDepth = 0
      this.dsmlSeen = 0
      this.dsmlBuf = ""
      this.mid = true
    }
  }

  // flushHold puts out what a finished stream left held: a tail that never
  // grew into a marker is text again, the tail of an unterminated DSML block
  // stays in the reasoning, and a half-open tool call — unexecutable by
  // definition — goes to the reasoning with the rest of its block.
  flushHold() {
    if (this.block === "tool" && this.toolBuf) {
      this.reasoning += `${TOOL_CALL_OPEN}${this.toolBuf}`
      this.toolBuf = ""
      this.block = null
    }
    if (this.block === "dsmltool" && (this.dsmlBuf || this.hold)) {
      // the remains of an unterminated DSML block: unexecutable markup, so
      // the reasoning keeps it visible and the reply stays clean
      this.reasoning += `${this.dsmlBuf}${this.hold}`
      this.dsmlBuf = ""
      this.hold = ""
      this.block = null
    }
    if (!this.hold) return
    const held = this.hold
    this.hold = ""
    if (this.block === "dsml" || this.mid) this.reasoning += held
    else this.text += held
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

export { PatchReader, iterSse }
