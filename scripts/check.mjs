#!/usr/bin/env bun
// Loads this plugin the way Magpie's host (and OpenCode) does and checks the
// shape of what it returns: an auth hook with a provider, a loader and sign-in
// methods the host knows, and a config hook that declares the provider with an
// SDK and models. It signs in to nothing and sends no request.
import { pathToFileURL } from "node:url"

const problems = []
try {
  const mod = await import(new URL("../src/index.mjs", import.meta.url).href)
  const fns = Object.values(mod).filter((value) => typeof value === "function")
  if (!fns.length) problems.push("exports no plugin function")
  const client = {
    app: { log: async () => {} },
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
    config: { get: async () => ({ data: {} }) },
  }
  for (const fn of fns) {
    const hooks = await fn({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
    const auth = hooks?.auth
    if (!auth) { problems.push(`${fn.name}: no auth hook`); continue }
    if (typeof auth.provider !== "string" || !auth.provider) problems.push(`${fn.name}: auth.provider`)
    if (typeof auth.loader !== "function") problems.push(`${fn.name}: auth.loader`)
    if (!Array.isArray(auth.methods) || !auth.methods.length) problems.push(`${fn.name}: auth.methods`)
    for (const method of auth.methods ?? []) {
      if (!["oauth", "api"].includes(method.type)) problems.push(`${fn.name}: method type ${method.type}`)
      if (method.type === "oauth" && typeof method.authorize !== "function") problems.push(`${fn.name}: ${method.label} has no authorize`)
    }
    if (hooks["chat.headers"] && typeof hooks["chat.headers"] !== "function") problems.push(`${fn.name}: chat.headers is not a function`)
    if (hooks.config) {
      const config = { provider: {} }
      await hooks.config(config)
      const provider = config.provider[auth.provider]
      if (provider && (!provider.npm || !provider.models || !Object.keys(provider.models).length)) {
        problems.push(`${fn.name}: config gives ${auth.provider} no npm or models`)
      } else if (provider) {
        console.log(`  provider ${auth.provider}: ${Object.keys(provider.models).join(", ")} (${provider.npm})`)
      }
    }
  }
} catch (error) {
  problems.push(String(error?.stack ?? error))
}
if (problems.length) {
  console.error(`✗ magpie-deepseek-web-auth\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("✓ magpie-deepseek-web-auth")
