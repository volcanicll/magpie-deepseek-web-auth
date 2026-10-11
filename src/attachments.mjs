// Attachments
//
// The page sends files ahead of the turn: multipart to /api/v0/file/upload_file
// — one of the page's two proof-of-work scenes, the other being the completion
// — with the page's x-thinking-enabled/x-model-type/x-file-size headers on
// top, then the file's parse status off /api/v0/file/fetch_files until it
// reads SUCCESS. The turn references the uploaded id in `ref_file_ids`. The
// server types the file itself (model_kind VISION for images, which the
// default model reads through its own vision feature), so no fork is needed,
// and it refuses a turn that carries files with thinking on, so an attachment
// turn runs on `default` with thinking off. It takes the page's plain header
// set and nothing more: the client-hint / device headers a non-browser adds
// are what its risk layer answers MISSING_HEADER to.

import { solvePow, powHeader } from "./pow.mjs"
import { UPLOAD_PATH } from "./config.mjs"
import { headers, json, challenge, sleep } from "./api.mjs"

const IMAGE_MIME = /^image\//
const PARSE_POLL_MS = 400
const PARSE_TIMEOUT_MS = 15_000
// The parse states that mean the file will never read; it is left out rather
// than referenced.
const PARSE_FAILED = new Set(["FAILED", "CONTENT_FILTER", "CONTENT_TOO_LONG", "CANCELLED", "CONTENT_EMPTY", "_CUSTOM_SYSTEM_ERROR_FAIL"])
const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
}

// decodeDataUrl splits a `data:` URL into its bytes and media type.
function decodeDataUrl(text) {
  const comma = text.indexOf(",")
  if (comma === -1) return null
  const meta = text.slice(5, comma)
  const mime = meta.split(";")[0]?.trim() || "application/octet-stream"
  let data
  try {
    data = Buffer.from(text.slice(comma + 1), /base64/i.test(meta) ? "base64" : "utf8")
  } catch {
    return null
  }
  return { data, mime }
}

// filenameFor names an attachment for the upload, from the part when it names
// itself and from its media type when it does not.
function filenameFor(attachment) {
  if (attachment.filename) return attachment.filename
  const ext = EXT_BY_MIME[attachment.mime]
  return attachment.kind === "image" ? `image.${ext ?? "png"}` : ext ? `document.${ext}` : "document.bin"
}

// attachmentFromPart reads one OpenAI content part into an attachment: an
// image_url part (a data URL, or an http(s) one downloaded here) or a file
// part (file_data as a data URL or bare base64). A part the page could not
// carry comes back null and is simply left out.
async function attachmentFromPart(part, signal) {
  if (!part || typeof part !== "object") return null
  if (part.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    if (typeof url !== "string" || !url) return null
    if (/^data:/i.test(url)) {
      const decoded = decodeDataUrl(url)
      return decoded && { kind: "image", ...decoded, filename: null }
    }
    if (!/^https?:\/\//i.test(url)) return null
    const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(20_000) }).catch(() => null)
    if (!response?.ok) return null
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() || "image/png"
    return { kind: "image", data: Buffer.from(await response.arrayBuffer()), mime, filename: null }
  }
  if (part.type === "file") {
    const file = typeof part.file === "object" && part.file ? part.file : {}
    const filename = typeof file.filename === "string" && file.filename ? file.filename : null
    const raw = typeof file.file_data === "string" ? file.file_data : typeof file.data === "string" ? file.data : null
    if (!raw) return null
    if (/^data:/i.test(raw)) {
      const decoded = decodeDataUrl(raw)
      return decoded && { kind: IMAGE_MIME.test(decoded.mime) ? "image" : "file", ...decoded, filename }
    }
    const mime = typeof file.content_type === "string" && file.content_type ? file.content_type : "application/octet-stream"
    return { kind: IMAGE_MIME.test(mime) ? "image" : "file", data: Buffer.from(raw, "base64"), mime, filename }
  }
  return null
}

// extractAttachments gathers the attachments a turn carries, from the same
// slice messagesToPrompt reads: the turns before `from` are already in the web
// session, so their files are not sent a second time.
async function extractAttachments(messages, from = 0, signal) {
  const list = messages ?? []
  const out = []
  let index = Math.max(0, from)
  while (index < list.length && (list[index]?.role === "assistant" || list[index]?.role === "tool")) index += 1
  for (; index < list.length; index++) {
    const content = list[index]?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object" || part.type === "text") continue
      try {
        const attachment = await attachmentFromPart(part, signal)
        if (attachment) out.push(attachment)
      } catch {
        // an unreadable part is left out, not fatal
      }
    }
  }
  return out
}

// uploadFile puts one attachment on the upload endpoint: its own proof of work
// first, then the page's three upload headers, then the multipart body with
// the single `file` field the page sends. The model type the file is for is
// always `default` — the model an attachment turn runs on; the server types
// the file's reading path itself.
async function uploadFile(origin, token, attachment, signal) {
  const pow = await challenge(origin, token, UPLOAD_PATH, signal)
  const answer = solvePow(pow, { signal })
  const head = headers(origin, token, {
    "x-ds-pow-response": powHeader(pow, answer, { targetPath: UPLOAD_PATH }),
    "x-thinking-enabled": "0",
    "x-model-type": "default",
    "x-file-size": String(attachment.data.length),
  })
  delete head["content-type"] // the multipart boundary must come from the body
  const form = new FormData()
  form.append("file", new Blob([attachment.data], { type: attachment.mime }), filenameFor(attachment))
  const response = await fetch(`${origin}${UPLOAD_PATH}`, { method: "POST", headers: head, body: form, signal })
  const biz = await json(response, "file upload")
  const id = biz?.id ?? biz?.file?.id
  if (!id) throw new Error("DeepSeek file upload: no file id returned")
  return id
}

// fileStatus asks one uploaded (or forked) file's parse state.
async function fileStatus(origin, token, fileId, signal) {
  const response = await fetch(`${origin}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(String(fileId))}`, {
    method: "GET",
    headers: headers(origin, token),
    signal,
  })
  const biz = await json(response, "file status")
  const files = Array.isArray(biz?.files) ? biz.files : []
  const hit = files.find((file) => file?.id === fileId) ?? files[0]
  return typeof hit?.status === "string" ? hit.status.toUpperCase() : null
}

// waitParsed polls the parse status until the file reads SUCCESS, a state it
// will never leave, or the wait runs out — a file still parsing at the end is
// referenced anyway, as the page does once its own wait is up.
async function waitParsed(origin, token, fileId, signal) {
  const deadline = Date.now() + PARSE_TIMEOUT_MS
  for (;;) {
    const status = await fileStatus(origin, token, fileId, signal).catch(() => null)
    if (status === "SUCCESS") return true
    if (status && PARSE_FAILED.has(status)) return false
    if (Date.now() >= deadline) return true
    await sleep(PARSE_POLL_MS)
  }
}

// prepareFiles takes a turn's attachments the whole way: uploaded (with its
// own proof of work) and waited for parse. What made it through comes back in
// ref_file_ids; what did not comes back as a note for the prompt, so a file
// DeepSeek refused says so instead of vanishing. The page's fork step is only
// for switching a file to another model after the fact — a fresh upload is
// referenced as it is.
async function prepareFiles(origin, token, attachments, signal) {
  const refFileIds = []
  const notes = []
  if (!attachments.length) return { refFileIds, notes }
  const uploaded = []
  for (const attachment of attachments) {
    const name = filenameFor(attachment)
    try {
      const id = await uploadFile(origin, token, attachment, signal)
      uploaded.push({ id, name })
    } catch (error) {
      notes.push(`[Note: attachment "${name}" could not be delivered to DeepSeek: ${error?.message ?? error}]`)
    }
  }
  for (const file of uploaded) {
    if (await waitParsed(origin, token, file.id, signal)) refFileIds.push(file.id)
    else notes.push(`[Note: attachment "${file.name}" was not readable by DeepSeek and was left out.]`)
  }
  return { refFileIds, notes }
}

export { decodeDataUrl, filenameFor, extractAttachments, uploadFile, fileStatus, waitParsed, prepareFiles }
