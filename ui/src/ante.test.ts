// Run with: node --test src/ante.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import * as ed from "@noble/ed25519";
import { bitsOf, challengeBytes, checkProof, clean, grind, makeProof, reportPurpose, type ReportBody } from "./ante.ts";

const hex = ed.etc.bytesToHex;
const body: ReportBody = { target: "AbC123", track: 2, kind: "copyright", note: "This is a song by X", contact: "", ts: 1700000000000 };

// The same vector as `a_proof_made_by_the_ui_code_verifies` in reports/src/lib.rs, which the contract accepts.
const PURPOSE = "freetunes:report:v1:fd456f77b254ef4d5467e6668d54ec5ca71c3b1df4a95ea09526ee08036c93f3";
const VK = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

test("purpose commits to every field of the report", () => {
  assert.equal(reportPurpose(body), PURPOSE);
  for (const edit of [{ note: "x" }, { track: 3 }, { target: "Other1" }, { kind: "illegal" as const }, { contact: "a@b.c" }, { ts: body.ts + 1 }]) {
    assert.notEqual(reportPurpose({ ...body, ...edit }), PURPOSE);
  }
});

test("grind, sign and check a proof the way the delegate and the contract do", async () => {
  const sk = new Uint8Array(32).fill(7), vk = await ed.getPublicKeyAsync(sk);
  assert.equal(hex(vk), VK);
  const nonce = await grind(challengeBytes(PURPOSE, vk), 18);
  assert.equal(nonce, 75010); // smallest nonce, same as the Rust side finds
  assert.ok(bitsOf(challengeBytes(PURPOSE, vk), nonce) >= 18);
  const { bytes } = await makeProof(sk, PURPOSE, nonce, body.ts);
  assert.equal((await checkProof(bytes, PURPOSE)).nonce, nonce);
  await assert.rejects(checkProof(bytes, reportPurpose({ ...body, note: "x" })), /something else/);
  const weak = await makeProof(sk, PURPOSE, nonce + 1, body.ts); // a different nonce: almost surely below 18 bits
  if (bitsOf(challengeBytes(PURPOSE, vk), nonce + 1) < 18) await assert.rejects(checkProof(weak.bytes, PURPOSE), /not enough work/);
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 2] ^= 1; // flips a signature byte
  await assert.rejects(checkProof(tampered, PURPOSE), /signature/);
});

test("clean strips line breaks and control characters", () => {
  assert.equal(clean("a\nb\r\n c\u0007d ", 50), "a b  c d");
  assert.equal(clean("x".repeat(20), 5), "xxxxx");
});
