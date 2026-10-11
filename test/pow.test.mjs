import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sha3Digest, deepSeekHashV1, solvePow, powHeader, powPrefix, MAX_DIFFICULTY } from "../src/pow.mjs"

// SHA3-256 with all 24 rounds is FIPS 202's own digest, so node:crypto can pin
// the permutation, padding and multi-block absorption — the parts a
// DeepSeekHashV1 port gets wrong silently.
test("sha3Digest(24) is SHA3-256", () => {
  for (const input of ["", "abc", "a".repeat(135), "a".repeat(136), "a".repeat(137), "a".repeat(272), "中文测试", "x".repeat(1000)]) {
    expect(sha3Digest(input, 24)).toBe(createHash("sha3-256").update(input, "utf8").digest("hex"))
  }
})

// The vendor's own pow_solver.wasm is the authority on DeepSeekHashV1. These
// digests were read out of that wasm's wasm_deepseek_hash_v1 export.
const WASM_DIGESTS = [
  ["", "e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3"],
  ["abc", "f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506"],
  ["a".repeat(135), "1e3eb415bb0b3ecec08a6f71cf7c8d0591b5594752ba52802a2e60357834f998"],
  ["a".repeat(136), "680364b336f77918ed390287a581f96f1371599825acd1e348fa7649fcecbbab"],
  ["a".repeat(137), "dfeb7768d4d48053c083d849570e84cc8120520790f2d09cb56e40038081fab4"],
  ["salt_1791638192759_0", "5b56633fd742cf27d4510c0b213c40f673d3b7089bb6b7ec5a1b72b16fc79310"],
  ["salt_1791638192759_12345", "fecb1cc19748bf476ece2fc22bcfb94d974f3b630cbeb8d1b3ff1550dbd711eb"],
  ["x".repeat(300), "31e036e2f0c5e1761b18fba0c2907cc7abf9b40a58cf015e69704e3deb87fc96"],
]

const wasmPath = join(import.meta.dir, "fixtures", "pow_solver.wasm")
const haveWasm = (() => {
  try {
    readFileSync(wasmPath)
    return true
  } catch {
    return false
  }
})()

if (haveWasm) {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
    wasi_snapshot_preview1: { fd_write: () => 0, proc_exit: () => {} },
  })
  const ex = instance.exports
  const mem = () => new Uint8Array(ex.memory.buffer)
  const write = (text) => {
    const bytes = new TextEncoder().encode(text)
    const ptr = ex.__wbindgen_export_0(bytes.length, 1)
    mem().set(bytes, ptr)
    return [ptr, bytes.length]
  }
  const wasmHash = (input) => {
    const [ptr, length] = write(input)
    const out = ex.__wbindgen_add_to_stack_pointer(-16)
    ex.wasm_deepseek_hash_v1(out, ptr, length)
    const view = new DataView(ex.memory.buffer, out, 16)
    const at = view.getInt32(0, true)
    const size = view.getInt32(4, true)
    const digest = new TextDecoder().decode(mem().slice(at, at + size))
    ex.__wbindgen_add_to_stack_pointer(16)
    return digest
  }
  test("deepSeekHashV1 matches the vendor's own wasm", () => {
    for (const [input] of WASM_DIGESTS) expect(deepSeekHashV1(input)).toBe(wasmHash(input))
  })
  test("solvePow finds the nonce the vendor's wasm accepts", () => {
    for (const difficulty of [1, 2, 3, 64, 1000]) {
      for (const nonce of [...new Set([0, 1, difficulty - 1])].filter((n) => n < difficulty)) {
        const salt = `s${difficulty}x${nonce}`
        const expireAt = 1791638192759
        const prefix = powPrefix({ salt, expireAt })
        const wasmAnswer = ex
        const challenge = {
          algorithm: "DeepSeekHashV1",
          challenge: wasmHash(prefix + String(nonce)),
          salt,
          difficulty,
          expireAt,
        }
        expect(solvePow(challenge)).toBe(nonce)
        // and the vendor's solver agrees with the digest we built the challenge from
        const [cp, cl] = write(challenge.challenge)
        const [pp, pl] = write(prefix)
        const out = ex.__wbindgen_add_to_stack_pointer(-16)
        ex.wasm_solve(out, cp, cl, pp, pl, difficulty)
        const status = new DataView(ex.memory.buffer, out, 4).getInt32(0, true)
        const value = new DataView(ex.memory.buffer, out + 8, 8).getFloat64(0, true)
        ex.__wbindgen_add_to_stack_pointer(16)
        expect(status).not.toBe(0)
        expect(value).toBe(nonce)
        void wasmAnswer
      }
    }
  })
}

test("deepSeekHashV1 differs from SHA3-256 (round 0 is skipped)", () => {
  expect(deepSeekHashV1("abc")).not.toBe(sha3Digest("abc", 24))
})

test("solvePow searches nonce 0..difficulty-1 over salt_expireAt_nonce", () => {
  const salt = "abc"
  const expireAt = 1791638192759
  const prefix = powPrefix({ salt, expireAt })
  expect(prefix).toBe("abc_1791638192759_")
  const challenge = { algorithm: "DeepSeekHashV1", challenge: deepSeekHashV1(`${prefix}7`), salt, difficulty: 20, expireAt }
  expect(solvePow(challenge)).toBe(7)
})

test("solvePow refuses what it cannot solve rather than looping forever", () => {
  const challenge = { algorithm: "DeepSeekHashV1", challenge: "0".repeat(64), salt: "s", difficulty: 16, expireAt: 1 }
  expect(() => solvePow(challenge)).toThrow(/not solved within 16 tries/)
})

test("solvePow validates the challenge", () => {
  const base = { algorithm: "DeepSeekHashV1", challenge: "a".repeat(64), salt: "s", difficulty: 8, expireAt: 1 }
  expect(() => solvePow({ ...base, algorithm: "sha256" })).toThrow(/not DeepSeekHashV1/)
  expect(() => solvePow({ ...base, challenge: "zz" })).toThrow(/64-character hex/)
  expect(() => solvePow({ ...base, salt: "" })).toThrow(/no salt/)
  expect(() => solvePow({ ...base, difficulty: 0 })).toThrow(/positive whole number/)
  expect(() => solvePow({ ...base, difficulty: MAX_DIFFICULTY + 1 })).toThrow(/above/)
  expect(() => solvePow({ ...base, expireAt: 1.5 })).toThrow(/expire_at/)
  expect(() => solvePow(null)).toThrow(/challenge missing/)
})

test("solvePow honours an abort signal and reports progress", () => {
  const challenge = { algorithm: "DeepSeekHashV1", challenge: "0".repeat(64), salt: "s", difficulty: 100000, expireAt: 1 }
  const controller = new AbortController()
  const seen = []
  expect(() =>
    solvePow(challenge, {
      signal: controller.signal,
      tick: 100,
      onProgress: (n) => {
        seen.push(n)
        if (n >= 300) controller.abort(new Error("stopped"))
      },
    }),
  ).toThrow(/stopped/)
  expect(seen.length).toBeGreaterThan(0)
})

test("powHeader is the base64 the x-ds-pow-response header carries", () => {
  const challenge = { algorithm: "DeepSeekHashV1", challenge: "a".repeat(64), salt: "salt", signature: "sig", targetPath: "/api/v0/chat/completion" }
  const decoded = JSON.parse(Buffer.from(powHeader(challenge, 42), "base64").toString("utf8"))
  expect(decoded).toEqual({
    algorithm: "DeepSeekHashV1",
    challenge: "a".repeat(64),
    salt: "salt",
    answer: 42,
    signature: "sig",
    target_path: "/api/v0/chat/completion",
  })
})
