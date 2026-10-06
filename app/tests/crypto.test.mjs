import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/crypto.js";

const IT = 1000; // low iterations keep the tests fast; production uses PBKDF2_ITERATIONS
const te = new TextEncoder();
const td = new TextDecoder();

test("production iteration count is at least 600k", () => {
  assert.ok(C.PBKDF2_ITERATIONS >= 600_000);
});

test("createVault: right passcode opens, wrong passcode returns null", async () => {
  const { meta, key } = await C.createVault("purple-otter-42", IT);
  assert.equal(meta.v, 1);
  assert.equal(meta.iterations, IT);
  assert.equal(meta.kdf, "PBKDF2-SHA-256");
  for (const f of ["salt", "iv", "wrapped"]) assert.equal(typeof meta[f], "string");
  assert.equal(key.extractable, false, "working key must not be extractable");
  assert.ok(await C.openVault(meta, "purple-otter-42"));
  assert.equal(await C.openVault(meta, "purple-otter-43"), null);
  assert.equal(await C.openVault(meta, ""), null);
  assert.equal(await C.openVault(null, "purple-otter-42"), null);
  assert.equal(await C.openVault({ ...meta, v: 2 }, "purple-otter-42"), null);
});

test("passcode is NFKC-normalised", async () => {
  const { meta } = await C.createVault("café-time", IT);
  assert.ok(await C.openVault(meta, "café-time"));
});

test("two vaults with the same passcode use different salts and keys", async () => {
  const a = await C.createVault("same-pass-1", IT);
  const b = await C.createVault("same-pass-1", IT);
  assert.notEqual(a.meta.salt, b.meta.salt);
  assert.notEqual(a.meta.wrapped, b.meta.wrapped);
});

test("seal/open roundtrip, with a fresh IV each time", async () => {
  const { key } = await C.createVault("roundtrip-pass", IT);
  const msg = te.encode("Pip the bunny lived in a little house");
  const a = await C.seal(key, msg, "records/abc");
  const b = await C.seal(key, msg, "records/abc");
  assert.equal(a.iv.length, 12);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ct, b.ct);
  assert.ok(!td.decode(a.ct).includes("bunny"), "ciphertext must not contain plaintext");
  assert.equal(td.decode(await C.open(key, a, "records/abc")), "Pip the bunny lived in a little house");
  const obj = { id: "abc", name: "Mousie", n: [1, 2, 3] };
  const s = await C.sealJSON(key, obj, "records/abc");
  assert.deepEqual(await C.openJSON(key, s, "records/abc"), obj);
});

test("AAD mismatch fails (records can't be swapped)", async () => {
  const { key } = await C.createVault("aad-pass-99", IT);
  const s = await C.sealJSON(key, { secret: 1 }, "records/one");
  assert.equal(await C.open(key, s, "records/two"), null);
  assert.equal(await C.openJSON(key, s, "images/one"), null);
});

test("tampered ciphertext or IV fails", async () => {
  const { key } = await C.createVault("tamper-pass", IT);
  const s = await C.seal(key, te.encode("hello world"), "x");
  const ct = s.ct.slice(); ct[0] ^= 1;
  assert.equal(await C.open(key, { iv: s.iv, ct }, "x"), null);
  const tag = s.ct.slice(); tag[tag.length - 1] ^= 0x80;
  assert.equal(await C.open(key, { iv: s.iv, ct: tag }, "x"), null);
  const iv = s.iv.slice(); iv[3] ^= 1;
  assert.equal(await C.open(key, { iv, ct: s.ct }, "x"), null);
  assert.equal(await C.open(key, { iv: s.iv, ct: s.ct.subarray(0, 4) }, "x"), null);
});

test("a different vault's key can't open data", async () => {
  const a = await C.createVault("vault-a-pass", IT);
  const b = await C.createVault("vault-b-pass", IT);
  const s = await C.seal(a.key, te.encode("private"), "r");
  assert.equal(await C.open(b.key, s, "r"), null);
});

test("rewrapVault: data stays readable with new passcode, not with old", async () => {
  const { meta, key } = await C.createVault("old-pass-11", IT);
  const s = await C.sealJSON(key, { story: "dragon" }, "records/r1");
  assert.equal(await C.rewrapVault(meta, "wrong-pass", "new-pass-22"), null);
  const next = await C.rewrapVault(meta, "old-pass-11", "new-pass-22");
  assert.ok(next);
  assert.equal(next.iterations, IT);
  assert.notEqual(next.salt, meta.salt);
  assert.equal(await C.openVault(next, "old-pass-11"), null);
  const k2 = await C.openVault(next, "new-pass-22");
  assert.ok(k2);
  assert.equal(k2.extractable, false);
  assert.deepEqual(await C.openJSON(k2, s, "records/r1"), { story: "dragon" });
});

test("passcodeProblem rules", () => {
  for (const bad of [undefined, null, 123456, "", "abc", "12345"]) assert.equal(typeof C.passcodeProblem(bad), "string", String(bad));
  assert.match(C.passcodeProblem("aaaaaaa"), /repeat/i);
  assert.match(C.passcodeProblem("111111"), /./);
  assert.match(C.passcodeProblem("Password"), /easy/i);
  assert.match(C.passcodeProblem("QWERTY"), /easy/i);
  assert.match(C.passcodeProblem("234567"), /sequence/i);
  assert.match(C.passcodeProblem("987654"), /sequence/i);
  assert.equal(C.passcodeProblem("482916"), null);
  assert.equal(C.passcodeProblem("purple-otter"), null);
  assert.equal(C.passcodeProblem("abcdeg"), null);
});

test("hashPicLock is deterministic for the same salt and differs otherwise", async () => {
  const seq = ["🍎", "🚗", "⭐"];
  const first = await C.hashPicLock(seq);
  assert.equal(C.b64.dec(first.salt).length, 16);
  assert.equal(C.b64.dec(first.hash).length, 32);
  const again = await C.hashPicLock(seq, first.salt);
  assert.deepEqual(again, first);
  assert.notEqual((await C.hashPicLock(["🍎", "⭐", "🚗"], first.salt)).hash, first.hash);
  assert.notEqual((await C.hashPicLock(seq)).hash, first.hash, "a new salt gives a new hash");
});

test("b64 roundtrip including large buffers", () => {
  const big = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7919) & 255);
  assert.deepEqual(C.b64.dec(C.b64.enc(big)), big);
  assert.equal(C.b64.enc(new Uint8Array([104, 105])), "aGk=");
  assert.match(C.randomId(), /^[0-9a-f]{32}$/);
});
