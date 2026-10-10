// DeepSeekHashV1, the proof-of-work chat.deepseek.com asks for before a
// completion: SHA3-256's sponge (rate 136, domain 0x06, 32-byte digest) with
// KECCAK-p[1600,23] — FIPS 202's permutation skipping its first round, so
// rounds 1..23, as the vendor's own pow_solver.wasm does. Solved answers were
// accepted by /api/v0/chat/completion against a real account, and every digest
// here matches that wasm byte for byte (rounds 0..23 of the SHA3-256 reference
// are checked against node:crypto too, which pins the permutation, padding and
// multi-block absorption independent of the vendor).
//
// The search is `nonce` from 0 to difficulty-1 over `salt_expireAt_nonce`, the
// answer being the nonce whose digest equals the challenge. Nothing is allocated
// per candidate: the prefix (and the empty tail) is absorbed once and only the
// nonce bytes are folded in per try, as the vendor's solver does.

const LANE_MASK = (1n << 64n) - 1n
const RATE = 136
const OUT = 32
const SALT_SEPARATOR = "_"

// Indexed as x + 5*y, matching the FIPS 202 state coordinates.
const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

const DEEPSEEK_HASH_ROUNDS = 23
const SHA3_DOMAIN_SUFFIX = 0x06
const DIGEST_HEX = /^[a-f0-9]{64}$/i
const HEX = "0123456789abcdef"

// A difficulty above this is refused rather than searched: the vendor asks
// around 144000, and a bound keeps a hostile challenge from pinning a host.
export const MAX_DIFFICULTY = 5_000_000

function rotateLeft(value, amount) {
  if (amount === 0) return value
  const shift = BigInt(amount)
  return ((value << shift) | (value >> (64n - shift))) & LANE_MASK
}

// The last `rounds` rounds of KECCAK-p[1600,24]: FIPS 202's permutation with
// its first round skipped for DeepSeekHashV1 (rounds = 23), all 24 for SHA3-256.
function permute(state, rounds) {
  const columnParity = new Array(5)
  const thetaMix = new Array(5)
  const rhoPi = new Array(25)
  for (let round = ROUND_CONSTANTS.length - rounds; round < ROUND_CONSTANTS.length; round++) {
    for (let x = 0; x < 5; x++) {
      columnParity[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    }
    for (let x = 0; x < 5; x++) {
      thetaMix[x] = columnParity[(x + 4) % 5] ^ rotateLeft(columnParity[(x + 1) % 5], 1)
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) state[x + 5 * y] ^= thetaMix[x]
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const destinationX = y
        const destinationY = (2 * x + 3 * y) % 5
        const lane = x + 5 * y
        rhoPi[destinationX + 5 * destinationY] = rotateLeft(state[lane], ROTATION_OFFSETS[lane])
      }
    }
    for (let y = 0; y < 5; y++) {
      const row = 5 * y
      for (let x = 0; x < 5; x++) {
        state[x + row] =
          rhoPi[x + row] ^ (~rhoPi[((x + 1) % 5) + row] & LANE_MASK & rhoPi[((x + 2) % 5) + row])
      }
    }
    state[0] ^= ROUND_CONSTANTS[round]
  }
}

// Absorbs one full rate block of the sponge.
function absorb(state, bytes, offset, rounds) {
  for (let index = 0; index < RATE; index++) {
    const lane = index >>> 3
    state[lane] ^= BigInt(bytes[offset + index]) << BigInt((index & 7) * 8)
  }
  permute(state, rounds)
}

// sha3Digest is the sponge over `input` with a selectable round count: 24 is
// SHA3-256 itself (checked against node:crypto in the tests), 23 is what
// DeepSeekHashV1 uses.
export function sha3Digest(input, rounds) {
  const bytes = new TextEncoder().encode(input)
  const state = new Array(25).fill(0n)
  let offset = 0
  while (offset + RATE <= bytes.length) {
    absorb(state, bytes, offset, rounds)
    offset += RATE
  }
  const remaining = bytes.length - offset
  for (let index = 0; index < remaining; index++) {
    state[index >>> 3] ^= BigInt(bytes[offset + index]) << BigInt((index & 7) * 8)
  }
  state[remaining >>> 3] ^= BigInt(SHA3_DOMAIN_SUFFIX) << BigInt((remaining & 7) * 8)
  state[(RATE - 1) >>> 3] ^= 0x80n << 56n
  permute(state, rounds)
  let digest = ""
  for (let index = 0; index < OUT; index++) {
    digest += HEX[Number((state[index >>> 3] >> BigInt((index & 7) * 8)) & 0xffn) >>> 4]
    digest += HEX[Number((state[index >>> 3] >> BigInt((index & 7) * 8)) & 0x0fn)]
  }
  return digest
}

export function deepSeekHashV1(input) {
  return sha3Digest(input, DEEPSEEK_HASH_ROUNDS)
}

// The prefix the challenge is checked against: salt, expire_at, then the nonce.
export const powPrefix = (challenge) => `${challenge.salt}${SALT_SEPARATOR}${challenge.expireAt}${SALT_SEPARATOR}`

function check(challenge, prefix) {
  if (!challenge || typeof challenge !== "object") throw new Error("DeepSeek PoW challenge missing")
  const { algorithm, challenge: digest, salt, difficulty, expireAt } = challenge
  if (algorithm !== "DeepSeekHashV1") {
    throw new Error(`DeepSeek PoW algorithm ${JSON.stringify(algorithm)} is not DeepSeekHashV1`)
  }
  if (typeof digest !== "string" || !DIGEST_HEX.test(digest)) {
    throw new Error("DeepSeek PoW challenge must be a 64-character hex digest")
  }
  if (typeof salt !== "string" || !salt) throw new Error("DeepSeek PoW challenge has no salt")
  if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
    throw new Error("DeepSeek PoW difficulty must be a positive whole number")
  }
  if (difficulty > MAX_DIFFICULTY) {
    throw new Error(`DeepSeek PoW difficulty ${difficulty} is above ${MAX_DIFFICULTY}`)
  }
  if (!Number.isSafeInteger(expireAt)) {
    throw new Error("DeepSeek PoW challenge has no expire_at")
  }
  return prefix ?? powPrefix({ salt, expireAt })
}

// solvePow answers one challenge: the nonce in [0, difficulty) whose digest is
// the challenge. It is synchronous and bounded by the difficulty, as the
// vendor's own solver is; `onProgress` (nonces tried so far, at most every
// `tick` tries) lets a caller keep a long search from looking like a hang.
export function solvePow(challenge, { onProgress, tick = 8192, signal } = {}) {
  const prefix = check(challenge)
  const prefixBytes = new TextEncoder().encode(prefix)
  const baseState = new Array(25).fill(0n)
  let offset = 0
  while (offset + RATE <= prefixBytes.length) {
    absorb(baseState, prefixBytes, offset, DEEPSEEK_HASH_ROUNDS)
    offset += RATE
  }
  const tailLength = prefixBytes.length - offset
  const tail = new Array(Math.ceil(tailLength / 4)).fill(0n)
  for (let index = 0; index < tailLength; index++) {
    tail[index >>> 3] ^= BigInt(prefixBytes[offset + index]) << BigInt((index & 7) * 8)
  }
  const wanted = challenge.challenge.toLowerCase()
  const target = new Array(OUT >>> 3).fill(0n)
  for (let index = 0; index < OUT; index++) {
    const byte = BigInt(`0x${wanted.slice(index * 2, index * 2 + 2)}`)
    target[index >>> 3] |= byte << BigInt((index & 7) * 8)
  }
  const state = new Array(25).fill(0n)
  const { difficulty } = challenge
  for (let nonce = 0; nonce < difficulty; nonce++) {
    if (signal?.aborted) throw signal.reason ?? new Error("DeepSeek PoW search was stopped")
    state.length = 0
    for (let lane = 0; lane < 25; lane++) state[lane] = baseState[lane]
    for (let lane = 0; lane < tail.length; lane++) state[lane] ^= tail[lane]
    let position = tailLength
    const text = String(nonce)
    for (let index = 0; index < text.length; index++) {
      state[position >>> 3] ^= BigInt(text.charCodeAt(index)) << BigInt((position & 7) * 8)
      position += 1
      if (position === RATE) {
        permute(state, DEEPSEEK_HASH_ROUNDS)
        position = 0
      }
    }
    state[position >>> 3] ^= BigInt(SHA3_DOMAIN_SUFFIX) << BigInt((position & 7) * 8)
    state[(RATE - 1) >>> 3] ^= 0x80n << 56n
    permute(state, DEEPSEEK_HASH_ROUNDS)
    let matched = true
    for (let lane = 0; lane < target.length; lane++) {
      if (state[lane] !== target[lane]) {
        matched = false
        break
      }
    }
    if (matched) return nonce
    if (onProgress && nonce % tick === tick - 1) onProgress(nonce + 1)
  }
  throw new Error(`DeepSeek PoW challenge was not solved within ${difficulty} tries`)
}

// powHeader is the base64 of the challenge's answer, as the x-ds-pow-response
// header carries it. Kept byte-compatible with the vendor's own solver (the
// answer is an integer, and target_path travels with it).
export function powHeader(challenge, answer, { targetPath } = {}) {
  const body = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath ?? challenge.targetPath ?? challenge.target_path ?? "",
  }
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64")
}

export const _internal = { permute, absorb, RATE, OUT, DEEPSEEK_HASH_ROUNDS }
