// The browser side of the report anti-spam: what a report commits to, the grind, and a local check of the proof the
// ante delegate returns. No browser or Freenet import, so a plain `node --test` can check it against the Rust side
// (reports/src/lib.rs, and ante-core: github.com/soudasuwa/ante, whose wire formats these follow).
import * as ed from "@noble/ed25519";
import { blake3 } from "@noble/hashes/blake3.js";
import { asBytes, asNumber, asString, cborDecode, cborEncode, mapGet, type CborValue } from "./cbor.ts";

const enc = new TextEncoder();
const hex = ed.etc.bytesToHex;

export const REPORT_BITS = 18; // must match MIN_BITS in reports/src/lib.rs
export const WHOLE_RELEASE = 255;
export const KINDS = ["copyright", "illegal", "other"] as const;
export type Kind = (typeof KINDS)[number];

/** The published ante delegate: blake3 of its wasm. The page refuses to talk to any other code. */
export const ANTE_CODE_HASH = "f10f40a38f2429f5499f503948001b2fd3a8e2923309ede75c47c9f0ce78925f";

export interface ReportBody { target: string; track: number; kind: Kind; note: string; contact: string; ts: number }

/** Free text without line breaks or other control characters (the contract refuses them). */
export const clean = (s: string, max: number) => s.replace(/[\p{Cc}]+/gu, " ").trim().slice(0, max);

/** What the ante purpose commits to: the whole report, so a proof cannot be reused for other content. */
export function reportPurpose(r: ReportBody): string {
  const s = `ftr1\n${r.target}\n${r.track}\n${r.kind}\n${r.note}\n${r.contact}\n${r.ts}`;
  return `freetunes:report:v1:${hex(blake3(enc.encode(s)))}`;
}

const u32le = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);
const u64le = (n: number) => new Uint8Array(new BigUint64Array([BigInt(n)]).buffer);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** ante_core::pow::challenge_bytes: what a nonce is ground against. The delegate returns the same bytes. */
export function challengeBytes(purpose: string, vk: Uint8Array): Uint8Array {
  const p = enc.encode(purpose);
  return cat(enc.encode("ante:pow-challenge:v1"), u32le(p.length), p, vk);
}

const zeroBits = (d: Uint8Array) => { let n = 0; for (const b of d) { n += Math.clz32(b) - 24; if (b) break; } return n; };

/** Leading zero bits of blake3(challenge || nonce as u64 le). */
export function bitsOf(challenge: Uint8Array, nonce: number): number {
  return zeroBits(blake3(cat(challenge, u64le(nonce))));
}

/** Find the smallest nonce reaching `bits` (about 2^bits hashes). Yields to the page now and then. */
export async function grind(challenge: Uint8Array, bits: number, progress?: (tried: number) => void): Promise<number> {
  const input = new Uint8Array(challenge.length + 8), view = new DataView(input.buffer);
  input.set(challenge);
  for (let nonce = 0; ; nonce++) {
    view.setBigUint64(challenge.length, BigInt(nonce), true);
    if (zeroBits(blake3(input)) >= bits) return nonce;
    if (nonce % 4000 === 3999) { progress?.(nonce + 1); await new Promise((r) => setTimeout(r)); }
  }
}

export interface Proof { vk: Uint8Array; purpose: string; nonce: number; ts: number; signature: Uint8Array }

export function decodeProof(b: Uint8Array): Proof {
  const m = cborDecode(b);
  return {
    vk: asBytes(mapGet(m, "identity_vk")), purpose: asString(mapGet(m, "purpose")), nonce: asNumber(mapGet(m, "nonce")),
    ts: asNumber(mapGet(m, "ts")), signature: asBytes(mapGet(m, "signature")),
  };
}

/** ante_core::proof::signing_bytes */
const signingBytes = (p: Proof) => {
  const purpose = enc.encode(p.purpose);
  return cat(enc.encode("ante:proof-signature:v1"), p.vk, u32le(purpose.length), purpose, u64le(p.nonce), u64le(p.ts));
};

/** Same checks as the contract (purpose, work, signature), so a bad proof is caught here rather than as a silent timeout. */
export async function checkProof(b: Uint8Array, expectedPurpose: string, minBits = REPORT_BITS): Promise<Proof> {
  const p = decodeProof(b);
  if (p.purpose !== expectedPurpose) throw new Error("the proof is for something else");
  if (bitsOf(challengeBytes(p.purpose, p.vk), p.nonce) < minBits) throw new Error("not enough work in the proof");
  if (!(await ed.verifyAsync(p.signature, signingBytes(p), p.vk))) throw new Error("bad proof signature");
  return p;
}

/** Test helper: what the ante delegate does (sign over a ground nonce). The real one runs inside the node. */
export async function makeProof(sk: Uint8Array, purpose: string, nonce: number, ts: number): Promise<{ bytes: Uint8Array; vk: Uint8Array }> {
  const vk = await ed.getPublicKeyAsync(sk);
  const signature = await ed.signAsync(signingBytes({ vk, purpose, nonce, ts, signature: new Uint8Array(64) }), sk);
  // ciborium writes struct fields in declaration order as a text-keyed map; [u8; N] fields are arrays of ints
  const bytes = cborEncode({ identity_vk: Array.from(vk), purpose, nonce, ts, signature: Array.from(signature) } as CborValue);
  return { bytes, vk };
}
