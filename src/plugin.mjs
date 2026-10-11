// The plugin
//
// `server` is the OpenCode/magpie plugin function: it declares the provider,
// signs in (from the browser profile or a pasted token), and hands the AI SDK
// a fetch that speaks chat.deepseek.com and answers in OpenAI chat completions.

import {
  PROVIDER,
  NAME,
  NPM,
  DEFAULT_ORIGIN,
  MODELS,
  CHAT_PATHS,
  configModels,
  accountLabel,
} from "./config.mjs"
import { whoAmI, findBrowserToken, findLiveBrowserToken } from "./browser-token.mjs"
import { deleteSession, isTitleRequest } from "./api.mjs"
import { encoder, chunk, finishReason, messagesToPrompt } from "./openai.mjs"
import { extractAttachments, prepareFiles } from "./attachments.mjs"
import { runTurn } from "./turn.mjs"

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
            // Web search rides the completion as the page's own toggle does:
            // on for every turn unless the request turns it off for itself.
            const search = body.search_enabled !== false
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
            // Tools ride the prompt as a protocol: the completion has no tools
            // field, so the prompt teaches the model the call shape and the
            // reply's <tool_call> blocks are parsed back into tool_calls.
            // tool_choice "none" says the client wants none of it, and a title
            // request is housekeeping with no tools of its own.
            const toolChoice = body.tool_choice ?? "auto"
            const wantsTools = toolChoice !== "none" && Array.isArray(body.tools) && body.tools.length > 0
            const tools = wantsTools && !titleRequest ? body.tools : null
            const known = sessions.get(sessionKey)
            let from = 0
            let deepseekSession = null
            let parentMessageId = null
            if (!titleRequest && known && known.sessionId && Date.now() - (known.at ?? 0) <= SESSION_TTL && known.count > 0 && known.count < messages.length) {
              deepseekSession = known.sessionId
              parentMessageId = known.messageId
              from = known.count
            }
            const prompt = messagesToPrompt(messages, from, { tools })
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
                  // The attachments ride the same slice as the prompt: only
                  // the files in the turns DeepSeek has not seen are sent, and
                  // a retry over the whole history sends all of them again.
                  const fromTurn = attempt === 0 ? from : 0
                  let promptTurn = attempt === 0 ? prompt : messagesToPrompt(messages, 0, { tools })
                  let refFileIds = []
                  if (!titleRequest) {
                    const prepared = await prepareFiles(origin, live, await extractAttachments(messages, fromTurn, request.signal), request.signal)
                    if (prepared.notes.length) promptTurn = [promptTurn, ...prepared.notes].filter(Boolean).join("\n\n")
                    refFileIds = prepared.refFileIds
                  }
                  const turn = runTurn({
                    origin,
                    token: live,
                    model,
                    prompt: promptTurn,
                    thinking,
                    search,
                    refFileIds,
                    tools: tools !== null,
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
                // Tool calls the model made come as their own deltas, complete
                // per call, and end the turn with finish_reason "tool_calls".
                const calls = last?.toolCalls ?? []
                for (const [index, call] of calls.entries()) {
                  controller.enqueue(encoder.encode(chunk(id, created, model.id, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] })))
                }
                controller.enqueue(encoder.encode(chunk(id, created, model.id, {}, calls.length ? "tool_calls" : finishReason(last?.status))))
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
              const calls = []
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
                if (choice) {
                  text += choice.delta?.content ?? ""
                  reasoning += choice.delta?.reasoning_content ?? ""
                  for (const call of choice.delta?.tool_calls ?? []) calls.push(call)
                  if (choice.finish_reason) finish = choice.finish_reason
                }
              }
              const message = { role: "assistant", content: text }
              if (reasoning) message.reasoning_content = reasoning
              if (calls.length) message.tool_calls = calls
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

