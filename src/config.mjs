// Identity, models and the page constants this plugin is built on.

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

// The proof-of-work scenes the page issues challenges for: the completion and
// the file upload, nothing else.
const UPLOAD_PATH = "/api/v0/file/upload_file"

function modelOf(model) {
  return {
    name: model.name,
    reasoning: model.thinking === "on",
    // Tools ride the prompt as a protocol, not the wire: the completion has no
    // tools field, so the plugin teaches the model the call shape and parses
    // the reply's <tool_call> blocks back into OpenAI tool_calls.
    tool_call: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: model.context, output: model.output },
    cost: { input: 0, output: 0 },
  }
}

function configModels() {
  return Object.fromEntries(MODELS.map((model) => [model.id, modelOf(model)]))
}

function accountLabel(token) {
  return `chat.deepseek.com · ${token.slice(0, 6)}…`
}

export {
  PROVIDER,
  NAME,
  DEFAULT_ORIGIN,
  NPM,
  APP_VERSION,
  MODELS,
  CHAT_PATHS,
  UPLOAD_PATH,
  modelOf,
  configModels,
  accountLabel,
}
