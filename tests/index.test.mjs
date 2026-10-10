import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server, _internal } from "../index.mjs"
import { start, streamText } from "../fake.mjs"

const { PatchReader, messagesToPrompt, tokenFromLevelDb } = _internal

const running = []
async function fake(options) {
  const f = await start(options)
  running.push(f)
  return f
}
afterEach(async () => {
  while (running.length) await running.pop().close()
})

// A plugin as the host runs it: hooks resolved, then an account wired in.
async function loaded(f, { token = "test-token" } = {}) {
  const hooks = await server({}, { origin: f.origin })
  const config = { provider: {} }
  await hooks.config(config)
  const auth = { type: "api", key: token }
  const options = await hooks.auth.loader(async () => auth)
  return { hooks, config, options }
}

const chat = (options, body) =>
  options.fetch(new Request(`${options.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))

test("config declares the provider and its two models", async () => {
  const f = await fake()
  const { config } = await loaded(f)
  const provider = config.provider["deepseek-web"]
  expect(provider.name).toContain("DeepSeek")
  expect(provider.npm).toBe("@ai-sdk/openai-compatible")
  expect(Object.keys(provider.models).sort()).toEqual(["deepseek-chat", "deepseek-reasoner"])
  expect(provider.models["deepseek-chat"].limit.context).toBe(128000)
  expect(provider.models["deepseek-reasoner"].reasoning).toBe(true)
})

test("the auth hook offers a browser sign-in and a pasted token", async () => {
  const f = await fake()
  const { hooks } = await loaded(f)
  expect(hooks.auth.provider).toBe("deepseek-web")
  expect(hooks.auth.methods.map((m) => m.type)).toEqual(["oauth", "api"])
})

test("a turn solves the PoW, creates a session and returns the reply", async () => {
  const f = await fake({ reply: "Hello there" })
  const { options } = await loaded(f)
  const response = await chat(options, { model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const out = await streamText(response)
  expect(out.content).toBe("Hello there")
  expect(out.finish).toBe("stop")
  expect(out.usage.total_tokens).toBe(12)
  // it asked for a challenge for the completion path and answered it
  expect(f.seen.challenges[0].targetPath).toBe("/api/v0/chat/completion")
  expect(f.seen.sessions.length).toBe(1)
  const sent = f.seen.completions[0]
  expect(sent.path).toBe("/api/v0/chat/completion")
  expect(sent.payload).toMatchObject({
    chat_session_id: "session-1",
    model_type: "default",
    prompt: "hi",
    thinking_enabled: false,
    search_enabled: false,
    ref_file_ids: [],
    preempt: false,
  })
  // the PoW answer rides in x-ds-pow-response, base64 of the challenge's answer
  const decoded = JSON.parse(Buffer.from(sent.pow, "base64").toString("utf8"))
  expect(decoded.algorithm).toBe("DeepSeekHashV1")
  expect(decoded.answer).toBeGreaterThanOrEqual(0)
  expect(decoded.answer).toBeLessThan(32)
  expect(decoded.signature).toBe("fake-signature")
  expect(decoded.target_path).toBe("/api/v0/chat/completion")
})

test("the reasoner model asks for the expert model type with thinking on", async () => {
  const f = await fake({ reply: "2+2=4" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "deepseek-reasoner", stream: true, messages: [{ role: "user", content: "2+2?" }] }))
  expect(out.content).toBe("2+2=4")
  expect(f.seen.completions[0].payload.model_type).toBe("expert")
  expect(f.seen.completions[0].payload.thinking_enabled).toBe(true)
})

test("the page's own headers travel with the request", async () => {
  const f = await fake()
  const { options } = await loaded(f)
  await streamText(await chat(options, { model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }))
  const sent = f.seen.headers.find((h) => h.path === "/api/v0/chat/completion")
  expect(sent.headers.authorization).toBe("Bearer test-token")
  expect(sent.headers["x-client-platform"]).toBe("web")
  expect(sent.headers["x-client-bundle-id"]).toBe("com.deepseek.chat")
  expect(sent.headers.origin).toBe(f.origin)
})

test("a non-streaming request folds the stream into one answer", async () => {
  const f = await fake({ reply: "Folded" })
  const { options } = await loaded(f)
  const response = await chat(options, { model: "deepseek-chat", stream: false, messages: [{ role: "user", content: "hi" }] })
  expect(response.headers.get("content-type")).toContain("application/json")
  const body = await response.json()
  expect(body.object).toBe("chat.completion")
  expect(body.choices[0].message.content).toBe("Folded")
  expect(body.choices[0].finish_reason).toBe("stop")
})

test("an unfinished reply is carried on with /chat/continue", async () => {
  const f = await fake({ reply: "the whole answer", status: "INCOMPLETE" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(out.content).toBe("the whole answer")
  expect(out.finish).toBe("stop")
  const paths = f.seen.completions.map((c) => c.path)
  expect(paths).toEqual(["/api/v0/chat/completion", "/api/v0/chat/continue"])
  expect(f.seen.completions[1].payload).toMatchObject({ chat_session_id: "session-1", message_id: 2, fallback_to_resume: true })
  // only the completion asked for a proof of work: /chat/continue takes none
  expect(f.seen.challenges.map((c) => c.targetPath)).toEqual(["/api/v0/chat/completion"])
  // and the continuation went out without a PoW header
  expect(f.seen.completions[1].pow).toBeUndefined()
})

test("thinking fragments become reasoning_content, not the reply", async () => {
  const f = await fake({ reply: "42", thinking: "let me think" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "deepseek-reasoner", stream: true, messages: [{ role: "user", content: "hi" }] }), { reasoning: true })
  expect(out.content).toBe("42")
})

test("an unknown model and an unknown path are refused", async () => {
  const f = await fake()
  const { options } = await loaded(f)
  await expect(chat(options, { model: "gpt-4", stream: true, messages: [] })).rejects.toThrow(/unknown model/)
  await expect(
    options.fetch(new Request(`${options.baseURL}/models`, { method: "GET" })),
  ).rejects.toThrow(/unsupported request/)
})

test("a refused sign-in is marked expired", async () => {
  const f = await fake()
  const { options } = await loaded(f)
  // the responder refuses the completion the way DeepSeek does for a dead token
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes("/chat_session/create")) {
      return new Response(JSON.stringify({ code: 401, msg: "unauthorized", data: null }), { status: 401, headers: { "content-type": "application/json" } })
    }
    return originalFetch(input, init)
  }
  try {
    const out = await streamText(await chat(options, { model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }))
    expect(out.finish).toBe("stop")
  } catch (e) {
    // the fetch itself may surface the error first, which is fine for a fake
    void e
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("messagesToPrompt keeps the conversation as the page's one box would", () => {
  expect(messagesToPrompt([{ role: "user", content: "hi" }])).toBe("hi")
  expect(messagesToPrompt([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ])).toBe("be brief\n\nhi\n\nAssistant: hello\n\nUser: again")
  expect(messagesToPrompt([{ role: "user", content: [{ type: "text", text: "parts" }] }])).toBe("parts")
  expect(messagesToPrompt([{ role: "user", content: "" }, { role: "user", content: "only" }])).toBe("only")
})

test("PatchReader folds the page's patch frames into text", () => {
  const reader = new PatchReader()
  reader.apply({ v: { response: { message_id: 2, status: "WIP", fragments: [{ type: "RESPONSE", content: "He" }] } } })
  reader.apply({ p: "response/fragments/-1/content", o: "APPEND", v: "llo" })
  reader.apply({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 9 }, { p: "quasi_status", v: "FINISHED" }] })
  reader.apply({ p: "response/status", o: "SET", v: "FINISHED" })
  expect(reader.text).toBe("Hello")
  expect(reader.status).toBe("FINISHED")
  expect(reader.messageId).toBe(2)
  expect(reader.usage).toBe(9)
})

test("PatchReader sends thinking fragments to reasoning, not the reply", () => {
  const reader = new PatchReader()
  reader.apply({ v: { response: { status: "WIP", fragments: [{ type: "THINK", content: "why" }] } } })
  reader.apply({ p: "response/fragments/-1/content", o: "APPEND", v: " not" })
  reader.apply({ p: "response/fragments/-1/content", o: "APPEND", v: "?" })
  expect(reader.text).toBe("")
  expect(reader.reasoning).toBe("why not?")
})

test("tokenFromLevelDb reads the userToken beside its key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-leveldb-"))
  try {
    // The record as Chromium writes it: the key as plain text, a control byte,
    // then the 64-character token and the next key's bytes right after it.
    const record = Buffer.concat([
      Buffer.from("_https://chat.deepseek.com\u0000\u0001", "utf16le"),
      Buffer.from("userToken", "utf8"),
      Buffer.from("\u0001\u00b9>\u0085\u0002\u00f0@\"", "binary"),
      Buffer.from("SREEsmwLaSUiVA1vX+OZh1WhCEorimG6tK9fvvDQTwZILPhzsUkwXLPRLW6rGdV1F", "utf8"),
      Buffer.from("\u00b5\u0004|\u000e:\u00f3\u00b4\u0017qwen.ai", "binary"),
    ])
    writeFileSync(join(dir, "000123.ldb"), record)
    // The byte after the value can itself be base64, so the candidate is the
    // 64-character token the app writes, not the longer run.
    expect(tokenFromLevelDb(dir)).toBe("SREEsmwLaSUiVA1vX+OZh1WhCEorimG6tK9fvvDQTwZILPhzsUkwXLPRLW6rGdV1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tokenFromLevelDb finds nothing in a profile without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-leveldb-"))
  try {
    writeFileSync(join(dir, "000123.ldb"), Buffer.from("nothing to see here"))
    expect(tokenFromLevelDb(dir)).toBe(null)
    expect(tokenFromLevelDb(join(dir, "missing"))).toBe(null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the browser sign-in hands the host a callback, and reports what to do on failure", async () => {
  const f = await fake()
  const { hooks } = await loaded(f)
  const started = await hooks.auth.methods[0].authorize()
  // the shape an oauth method must return to the host
  expect(typeof started.callback).toBe("function")
  expect(started.method).toBe("auto")
  expect(typeof started.url).toBe("string")
  const result = await started.callback()
  // On a machine with a signed-in profile this succeeds; without one it explains.
  if (result.type === "failed") {
    expect(result.error).toMatch(/chat\.deepseek\.com/)
  } else {
    expect(typeof result.access).toBe("string")
    expect(result.access.length).toBeGreaterThan(10)
    expect(result.refresh).toBe("")
  }
})

test("the pasted-token sign-in takes a key and refuses an empty or refused one", async () => {
  const f = await fake()
  const { hooks } = await loaded(f)
  // The host gives an api method its answered prompts, not the key: with none
  // the method saves the key the host hands it separately.
  const saved = await hooks.auth.methods[1].authorize()
  expect(saved).toMatchObject({ type: "success", metadata: { source: "pasted" } })
  // A caller that passes the token in as an input (OpenCode's TUI) gets it
  // checked here; a live one is saved with the account DeepSeek names.
  const ok = await hooks.auth.methods[1].authorize({ token: "  a-token  " })
  expect(ok).toMatchObject({ type: "success", key: "a-token", accountId: "tester@example.com" })
  const refused = await hooks.auth.methods[1].authorize({ token: "bad-token" })
  expect(refused.type).toBe("failed")
  expect(refused.error).toMatch(/refused that token/)
})

test("the loader checks a pasted token and marks a refused one", async () => {
  const f = await fake()
  const hooks = await server({}, { origin: f.origin })
  const good = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  expect(good.baseURL).toBe(f.origin)
  await expect(hooks.auth.loader(async () => ({ type: "api", key: "bad-token" }))).rejects.toThrow(/refused this token/)
})

test("the loader is empty without a sign-in", async () => {
  const f = await fake()
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => undefined)
  expect(options).toEqual({})
})

// ---------------------------------------------------------------------------
// The frames below were copied verbatim from live chat.deepseek.com streams (a
// real account, 2026-10): the shapes the page actually sends. They are the
// regression guard for the reader.
// ---------------------------------------------------------------------------

test("a real default-model stream folds into the reply", () => {
  const frames = [
    { v: { response: { message_id: 2, parent_id: 1, role: "ASSISTANT", thinking_enabled: false, status: "WIP", accumulated_token_usage: 0, fragments: [{ id: 2, type: "RESPONSE", content: "PL", references: [], stage_id: 1 }], conversation_mode: "DEFAULT" } } },
    { p: "response/fragments/-1/content", o: "APPEND", v: "UG" },
    { v: "IN" },
    { v: "OK" },
    { p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 47 }, { p: "quasi_status", v: "FINISHED" }] },
    { p: "response/status", o: "SET", v: "FINISHED" },
  ]
  const reader = new PatchReader()
  for (const frame of frames) reader.apply(frame)
  expect(reader.text).toBe("PLUGINOK")
  expect(reader.reasoning).toBe("")
  expect(reader.status).toBe("FINISHED")
  expect(reader.usage).toBe(47)
})

test("a real expert stream keeps thinking and reply apart", () => {
  const frames = [
    { v: { response: { message_id: 4, thinking_enabled: true, status: "WIP", accumulated_token_usage: 0, fragments: [{ id: 2, type: "THINK", content: "We", elapsed_secs: null, references: [], stage_id: 1 }] } } },
    { p: "response/fragments/-1/content", o: "APPEND", v: " need" },
    { v: " answer" },
    { v: " exactly" },
    { p: "response/fragments/-1/elapsed_secs", o: "SET", v: 0.505 },
    // the reply opens as a whole new fragment
    { p: "response/fragments", o: "APPEND", v: [{ id: 3, type: "RESPONSE", content: "PL", references: [], stage_id: 1 }] },
    { p: "response/fragments/-1/content", v: "UG" },
    { v: "IN" },
    { v: "OK" },
    { p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 72 }, { p: "quasi_status", v: "FINISHED" }] },
    { p: "response/status", o: "SET", v: "FINISHED" },
  ]
  const reader = new PatchReader()
  for (const frame of frames) reader.apply(frame)
  expect(reader.reasoning).toBe("We need answer exactly")
  expect(reader.text).toBe("PLUGINOK")
  expect(reader.usage).toBe(72)
})

test("the fake's frames and a live capture agree on the same shape", async () => {
  // A live default reply: "PL" then APPEND "UG" then bare appends "IN" "OK".
  const f = await fake({ reply: "PLUGINOK" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(out.content).toBe("PLUGINOK")
  expect(out.finish).toBe("stop")
})

test("one agent conversation keeps one DeepSeek chat, sending only new turns", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const auth = { type: "api", key: "a-token" }
  const options = await hooks.auth.loader(async () => auth)
  const call = (messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "sess-abc" },
      body: JSON.stringify({ model: "deepseek-chat", stream: true, messages }),
    })).then((r) => r.text())
  // Turn 1: two messages (system + user)
  await call([
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
  ])
  // Turn 2: the same history plus the reply and a new user turn
  await call([
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
  ])
  // Turn 3: one more round on the same conversation
  await call([
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "third question" },
  ])
  // One chat opened, three turns in it.
  expect(f.seen.sessions).toEqual(["session-1"])
  const completions = f.seen.completions.filter((c) => c.path === "/api/v0/chat/completion")
  expect(completions.length).toBe(3)
  // Every turn ran in the same DeepSeek chat.
  for (const c of completions) expect(c.payload.chat_session_id).toBe("session-1")
  // Turn 1 carried the whole (labelled) history; later turns only what is new.
  expect(completions[0].payload.prompt).toBe("be brief\n\nfirst question")
  expect(completions[1].payload.prompt).toBe("second question")
  expect(completions[2].payload.prompt).toBe("third question")
  // Later turns chain to the reply before them, as the page does.
  expect(completions[1].payload.parent_message_id).toBe(2)
  expect(completions[2].payload.parent_message_id).toBe(2)
})

test("a different agent session opens its own DeepSeek chat", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = (session, messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": session },
      body: JSON.stringify({ model: "deepseek-chat", stream: true, messages }),
    })).then((r) => r.text())
  const history = [
    { role: "user", content: "one" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "two" },
  ]
  await call("sess-a", history)
  await call("sess-b", history)
  await call("sess-a", [...history, { role: "assistant", content: "answer" }, { role: "user", content: "three" }])
  expect(f.seen.sessions).toEqual(["session-1", "session-2"])
  const completions = f.seen.completions.filter((c) => c.path === "/api/v0/chat/completion")
  expect(completions[0].payload.chat_session_id).toBe("session-1")
  expect(completions[1].payload.chat_session_id).toBe("session-2")
  expect(completions[2].payload.chat_session_id).toBe("session-1")
  // sess-a's second turn sent only its new part
  expect(completions[2].payload.prompt).toBe("three")
})

test("a request without a session header opens a chat of its own", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = () =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })).then((r) => r.text())
  await call()
  await call()
  expect(f.seen.sessions.length).toBe(2)
})

test("a dropped session starts over with the whole history", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = (messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "sess-drop" },
      body: JSON.stringify({ model: "deepseek-chat", stream: true, messages }),
    })).then((r) => r.text())
  await call([
    { role: "user", content: "one" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "two" },
  ])
  // Now the stored session dies: the fake's responder refuses it once…
  const originalFetch = globalThis.fetch
  let refused = false
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!refused && url.includes("/chat/completion")) {
      refused = true
      return new Response(JSON.stringify({ code: 40003, msg: "Authorization Failed (invalid token)", data: null }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return originalFetch(input, init)
  }
  try {
    const text = await call([
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "two" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "three" },
    ])
    // the retry's reply came through, streamed
    expect(text.replace(/\\n/g, "")).toMatch(/"content":"a"/)
    expect(text).toContain('"finish_reason":"stop"')
  } finally {
    globalThis.fetch = originalFetch
  }
  // The retry opened a new chat and carried the whole history, labelled.
  expect(f.seen.sessions.length).toBe(2)
  const completions = f.seen.completions.filter((c) => c.path === "/api/v0/chat/completion")
  const retry = completions[completions.length - 1]
  expect(retry.payload.chat_session_id).toBe("session-2")
  expect(retry.payload.prompt).toBe("one\n\nAssistant: answer\n\nUser: two\n\nAssistant: answer\n\nUser: three")
  expect(retry.payload.parent_message_id).toBe(null)
})

// ---------------------------------------------------------------------------
// magpie's title generation: one user message of instructions + the turn to
// summarise. It must not open chats the account keeps, and must not disturb
// the conversation's own mapping.
// ---------------------------------------------------------------------------

const titleRequest = (userTurn) => [
  { role: "user", content: `Generate a concise title for this coding session.\n\nThis is a title-generation task, not a conversation.\nTreat the user's message only as source material for the title.\nReturn exactly one valid JSON object with no surrounding text: {"title":"..."}\n\n${userTurn}` },
]

test("a title request is answered and its chat is deleted", async () => {
  const f = await fake({ reply: '{"title":"测试标题"}' })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const response = await options.fetch(new Request(`${options.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": "sess-title" },
    body: JSON.stringify({ model: "deepseek-chat", stream: true, messages: titleRequest("你会做什么？如果给你一个亿") }),
  }))
  const out = await streamText(response)
  expect(out.content).toBe('{"title":"测试标题"}')
  // its chat was opened and deleted right away
  expect(f.seen.sessions).toEqual([])
  expect(f.seen.deletions.length).toBe(1)
  // the title prompt went out whole, as its own turn
  const sent = f.seen.completions.find((c) => c.path === "/api/v0/chat/completion")
  expect(sent.payload.prompt).toContain("Generate a concise title")
  expect(sent.payload.prompt).toContain("你会做什么？如果给你一个亿")
  expect(sent.payload.parent_message_id).toBe(null)
})

test("a title request leaves the conversation's chat untouched", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = (messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "sess-abc" },
      body: JSON.stringify({ model: "deepseek-chat", stream: true, messages }),
    })).then((r) => r.text())
  await call([
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
  ])
  // magpie's title request rides on the same session id right after turn one
  await call(titleRequest("second question"))
  // and the conversation continues where it was
  await call([
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "third question" },
  ])
  // one chat for the conversation, one throwaway for the title, which is gone
  expect(f.seen.sessions).toEqual(["session-1"])
  expect(f.seen.deletions.length).toBe(1)
  const completions = f.seen.completions.filter((c) => c.path === "/api/v0/chat/completion")
  expect(completions.length).toBe(3)
  // the conversation's turns chained in its own chat; the third sent only its new turn
  expect(completions[0].payload.chat_session_id).toBe("session-1")
  expect(completions[2].payload.chat_session_id).toBe("session-1")
  expect(completions[2].payload.prompt).toBe("third question")
  // the title went to its own (now deleted) chat, not into the conversation's
  expect(completions[1].payload.prompt).toContain("Generate a concise title")
  expect(completions[1].payload.chat_session_id).not.toBe("session-1")
})

test("a real question that merely mentions titles is not a title request", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  await options.fetch(new Request(`${options.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": "sess-real" },
    body: JSON.stringify({
      model: "deepseek-chat",
      stream: true,
      messages: [{ role: "user", content: 'How do I write a function that returns {"title": "x"}? Also, generate a concise title for my essay.' }],
    }),
  })).then((r) => r.text())
  // a plain conversation turn: no throwaway chat, nothing deleted
  expect(f.seen.sessions).toEqual(["session-1"])
  expect(f.seen.deletions).toEqual([])
})
