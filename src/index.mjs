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
//   POST /api/v0/file/upload_file      an attachment, multipart, PoW of its own
//   POST /api/v0/file/fork_file_task   the file, forked to the reading model
//   GET  /api/v0/file/fetch_files      the file's parse status
//
// Everything is the web app's contract, not DeepSeek's OpenAI-compatible
// platform API (api.deepseek.com, which takes a pay-as-you-go key): the account
// is a chat.deepseek.com session, so it is used the way the chat page uses it,
// with the same headers, the same PoW (src/pow.mjs) and the same SSE. Models are
// the two the page offers, `default` (DeepSeek-V3 chat) and `expert` (the
// reasoning model), thinking on or off per request as the page's toggle does.
// Web search rides the same completion (`search_enabled`, on by default, as
// the page's toggle starts). Attachments go up ahead of the turn and ride
// `ref_file_ids`: the upload carries its own proof of work plus the page's
// x-thinking-enabled/x-model-type/x-file-size headers, the server types the
// file itself (VISION for images, which the default model reads through its
// vision feature), and the turn runs on `default` with thinking off — the web
// app's server refuses a turn that carries files with thinking on.
//
// A turn streams and may be cut off unfinished: the plugin then asks DeepSeek
// to carry on (`/api/v0/chat/continue`) so the reply arrives whole, which is
// what the page does when its own stream stops.

import { PROVIDER, MODELS } from "./config.mjs"
import { server } from "./plugin.mjs"
import {
  findBrowserToken,
  findLiveBrowserToken,
  browserTokens,
  whoAmI,
  tokenFromLevelDb,
  tokenCandidatesFromLevelDb,
  chromiumRoots,
} from "./browser-token.mjs"
import { envelope } from "./api.mjs"
import { PatchReader, iterSse } from "./stream.mjs"
import { messagesToPrompt, finishReason } from "./openai.mjs"
import { extractAttachments, decodeDataUrl } from "./attachments.mjs"
import { toolsToPrompt, parseToolCall, renderToolCall } from "./toolcall.mjs"

export { server }

export default { id: PROVIDER, server }

// for tests
export const _internal = {
  MODELS,
  PatchReader,
  iterSse,
  messagesToPrompt,
  extractAttachments,
  decodeDataUrl,
  toolsToPrompt,
  parseToolCall,
  renderToolCall,
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
