// Image payload format (inside the ciphertext): the original 1-type-byte format must still read,
// and new images carry their creation time so the unused-image sweep can spare recent edits.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeImage, decodeImage, SWEEP_GRACE_MS } from "../js/store.js";

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

test("new images carry type and creation time", () => {
  const t = Date.UTC(2026, 9, 6, 12, 0, 0);
  const jpg = decodeImage(encodeImage(bytes, "image/jpeg", t));
  assert.equal(jpg.mime, "image/jpeg");
  assert.equal(jpg.created, t);
  assert.deepEqual([...jpg.bytes], [...bytes]);
  const png = decodeImage(encodeImage(bytes, "image/png", t));
  assert.equal(png.mime, "image/png");
  assert.deepEqual([...png.bytes], [...bytes]);
});

test("images in the original format still read, and count as old (no time)", () => {
  for (const [code, mime] of [[1, "image/jpeg"], [2, "image/png"]]) {
    const pt = new Uint8Array(bytes.length + 1);
    pt[0] = code; pt.set(bytes, 1);
    const img = decodeImage(pt);
    assert.equal(img.mime, mime);
    assert.equal(img.created, 0);
    assert.deepEqual([...img.bytes], [...bytes]);
  }
});

test("unknown or truncated payloads are rejected", () => {
  assert.equal(decodeImage(null), null);
  assert.equal(decodeImage(new Uint8Array([])), null);
  assert.equal(decodeImage(new Uint8Array([3, 1, 2])), null);
  assert.equal(decodeImage(new Uint8Array([0x11, 1, 2])), null);
});

test("decoding works on a view into a larger buffer", () => {
  const t = 1_700_000_000_000;
  const enc = encodeImage(bytes, "image/png", t);
  const big = new Uint8Array(enc.length + 7);
  big.set(enc, 7);
  const img = decodeImage(big.subarray(7));
  assert.equal(img.created, t);
  assert.deepEqual([...img.bytes], [...bytes]);
});

test("the sweep's grace period is 24 hours", () => {
  assert.equal(SWEEP_GRACE_MS, 24 * 60 * 60 * 1000);
});
