// Encrypted local storage. IndexedDB only ever sees { id, iv, ct } — random ids and ciphertext.
// Profile names, stories, drawings and photos are all inside the ciphertext.
import * as C from "./crypto.js";

const DB_NAME = "wishcircle";
const DB_VERSION = 1;
const MAX_FAILS_FREE = 5;

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ["meta", "records", "images"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idbGet = (s, id) => tx(s, "readonly", (st) => st.get(id));
const idbAll = (s) => tx(s, "readonly", (st) => st.getAll());
const idbPut = (s, v) => tx(s, "readwrite", (st) => st.put(v));
const idbDel = (s, id) => tx(s, "readwrite", (st) => st.delete(id));
const idbClear = (s) => tx(s, "readwrite", (st) => st.clear());

let key = null;
const cache = new Map();
const urls = new Map();
const listeners = new Set();

export const isUnlocked = () => key !== null;
export const onLock = (fn) => listeners.add(fn);
export async function hasVault() { return !!(await idbGet("meta", "vault")); }

export async function setup(passcode) {
  const problem = C.passcodeProblem(passcode);
  if (problem) throw new Error(problem);
  const { meta, key: k } = await C.createVault(passcode);
  await idbPut("meta", { id: "vault", ...meta });
  key = k; cache.clear();
  requestPersistence();
}

// Throttle wrong guesses: after 5 misses, wait 30s, 60s, 120s… up to 1 hour.
async function throttle() { return (await idbGet("meta", "throttle")) || { id: "throttle", fails: 0, until: 0 }; }
async function recordFail() {
  const t = await throttle();
  t.fails++;
  if (t.fails >= MAX_FAILS_FREE) t.until = Date.now() + Math.min(3600, 30 * 2 ** (t.fails - MAX_FAILS_FREE)) * 1000;
  await idbPut("meta", t);
  return t.fails;
}
const clearFails = () => idbPut("meta", { id: "throttle", fails: 0, until: 0 });
export const FREE_TRIES = MAX_FAILS_FREE;
export async function lockoutRemaining() {
  const t = await throttle();
  return Math.max(0, Math.ceil((t.until - Date.now()) / 1000));
}

export async function unlock(passcode) {
  const wait = await lockoutRemaining();
  if (wait > 0) return { ok: false, wait };
  const meta = await idbGet("meta", "vault");
  const k = await C.openVault(meta, passcode);
  if (!k) {
    const fails = await recordFail();
    return { ok: false, wait: await lockoutRemaining(), fails };
  }
  await clearFails();
  key = k;
  epoch++;
  await loadAll();
  requestPersistence();
  scheduleSweep();
  return { ok: true };
}

// Check the passcode again (parent area) without changing state.
export async function verify(passcode) {
  if ((await lockoutRemaining()) > 0) return false;
  const meta = await idbGet("meta", "vault");
  const ok = !!(await C.openVault(meta, passcode));
  if (!ok) await recordFail();
  else await clearFails();
  return ok;
}

let unreadable = 0; // records that didn't open: the sweep can't know what they reference
async function loadAll() {
  cache.clear();
  unreadable = 0;
  for (const r of await idbAll("records")) {
    const obj = await C.openJSON(key, r, "records/" + r.id);
    if (obj && obj.id === r.id) cache.set(r.id, obj);
    else unreadable++;
  }
}

export function lock() {
  key = null;
  epoch++;
  drafts.clear(); // the editor is gone once locked; its unsaved images are left for the sweep
  clearTimeout(sweepTimer);
  cache.clear();
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  for (const fn of listeners) fn();
}

function need() { if (!key) throw new Error("locked"); }

export async function save(obj) {
  need();
  const rec = structuredClone(obj);
  rec.id ||= C.randomId();
  rec.updated = Date.now();
  rec.created ||= rec.updated;
  const sealed = await C.sealJSON(key, rec, "records/" + rec.id);
  await idbPut("records", { id: rec.id, ...sealed });
  cache.set(rec.id, rec);
  return structuredClone(rec);
}
export const get = (id) => (cache.has(id) ? structuredClone(cache.get(id)) : null);
export const list = (kind, pred = () => true) =>
  [...cache.values()].filter((o) => o.kind === kind && pred(o)).map((o) => structuredClone(o)).sort((a, b) => (a.created || 0) - (b.created || 0));
export async function remove(id) {
  need();
  await idbDel("records", id);
  cache.delete(id);
}

// Images. Plaintext = 1 type byte + file bytes.
//   1 = JPEG, 2 = PNG: the original format (no creation time; counts as old for the sweep).
//   0x11 = JPEG, 0x12 = PNG with an 8-byte creation time (ms since 1970, float64 big-endian)
//   between the type byte and the file bytes. The time is inside the ciphertext, like the rest.
const TYPES = { 1: "image/jpeg", 2: "image/png" };
const STAMPED = 0x10;
export function encodeImage(bytes, mime, created = Date.now()) {
  const pt = new Uint8Array(bytes.length + 9);
  pt[0] = STAMPED | (mime === "image/png" ? 2 : 1);
  new DataView(pt.buffer).setFloat64(1, created);
  pt.set(bytes, 9);
  return pt;
}
// → { mime, bytes, created (ms, or 0 for the original unstamped format) } or null.
export function decodeImage(pt) {
  if (!pt || pt.length < 1) return null;
  const t = pt[0];
  if (TYPES[t]) return { mime: TYPES[t], bytes: pt.subarray(1), created: 0 };
  if (t & STAMPED && TYPES[t & ~STAMPED] && pt.length >= 9) {
    const created = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getFloat64(1);
    return { mime: TYPES[t & ~STAMPED], bytes: pt.subarray(9), created: Number.isFinite(created) ? created : 0 };
  }
  return null;
}
export async function putImage(bytes, mime) {
  need();
  const id = C.randomId();
  const sealed = await C.seal(key, encodeImage(bytes, mime), "images/" + id);
  await idbPut("images", { id, ...sealed });
  return id;
}
async function openImage(id) {
  const r = await idbGet("images", id);
  if (!r) return null;
  return decodeImage(await C.open(key, r, "images/" + id));
}
export async function imageBlob(id) {
  need();
  const img = await openImage(id);
  return img ? new Blob([img.bytes], { type: img.mime }) : null;
}
export async function imageURL(id) {
  if (!id) return null;
  if (urls.has(id)) return urls.get(id);
  const b = await imageBlob(id);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urls.set(id, u);
  return u;
}
export async function deleteImage(id) {
  if (!id) return;
  need();
  await idbDel("images", id);
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
}

// ---------- Unused-image sweep ----------
// Photos and drawings are stored the moment they're added in the editor, before the book is
// saved. If the app locks (or the tab closes) mid-edit, those images are left behind. The sweep
// deletes images that no saved record mentions, with these safety rules:
//   • only while unlocked, and never while an editor has a draft open (beginDraft/endDraft);
//   • never an image made in the last SWEEP_GRACE_MS (24 h): it may belong to an open edit,
//     maybe in another tab; images in the original format have no time and count as old;
//   • never an image it can't open (it can't tell how old it is), and not at all if any record
//     failed to open (it can't tell what that record uses);
//   • anything any record mentions anywhere is kept, not only book covers, pages and cast;
//   • it stops at once if the app locks, the key changes or an editor opens meanwhile.
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const drafts = new Set();
let epoch = 0;
let sweeping = null;
let sweepTimer = 0;
export function beginDraft() { const t = {}; drafts.add(t); return t; }
export function endDraft(t) { drafts.delete(t); }
export const draftOpen = () => drafts.size > 0;

function referencedIds() {
  const ids = new Set();
  const walk = (v, depth) => {
    if (typeof v === "string") { if (v.length >= 16 && v.length <= 64) ids.add(v); }
    else if (v && typeof v === "object" && depth < 8) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const r of cache.values()) {
    if (r.kind === "book") for (const id of [r.cover, ...(r.pages || []).map((p) => p?.imageId), ...(r.cast || []).map((c) => c?.imageId)]) if (id) ids.add(id);
    walk(r, 0);
  }
  return ids;
}

export function sweepUnusedImages({ now = Date.now() } = {}) {
  return (sweeping ||= runSweep(now).finally(() => { sweeping = null; }));
}
async function runSweep(now) {
  const out = { checked: 0, deleted: 0, recent: 0, skipped: null };
  if (!key) return { ...out, skipped: "locked" };
  if (drafts.size) return { ...out, skipped: "editing" };
  if (unreadable) return { ...out, skipped: "unreadable records" };
  const k = key, ep = epoch;
  const ok = () => key === k && epoch === ep && drafts.size === 0;
  const ids = await tx("images", "readonly", (st) => st.getAllKeys());
  for (const id of ids || []) {
    if (!ok()) return { ...out, skipped: "interrupted" };
    if (referencedIds().has(id)) continue;
    out.checked++;
    let img = null;
    try { img = await openImage(id); } catch { img = null; }
    if (!img) continue; // can't read it, so can't tell its age: keep
    if (img.created && now - img.created < SWEEP_GRACE_MS) { out.recent++; continue; }
    if (!ok() || referencedIds().has(id)) continue;
    await idbDel("images", id);
    if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
    out.deleted++;
    await new Promise((r) => setTimeout(r, 0)); // stay out of the way of the UI
  }
  return out;
}
// Run the sweep a little after unlocking, when the browser is idle.
export function scheduleSweep(delay = 4000) {
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    const run = () => { sweepUnusedImages().catch(() => {}); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 15000 });
    else run();
  }, delay);
}

export async function changePasscode(oldPass, newPass) {
  const problem = C.passcodeProblem(newPass);
  if (problem) return problem;
  const wait = await lockoutRemaining();
  if (wait > 0) return `Too many wrong tries. Wait ${wait} seconds.`;
  const meta = await idbGet("meta", "vault");
  const next = await C.rewrapVault(meta, oldPass, newPass);
  if (!next) { await recordFail(); return "The current passcode is wrong."; }
  await clearFails();
  await idbPut("meta", { id: "vault", ...next });
  return null;
}

// Backup = the encrypted database as-is. Useless without the passcode.
export async function exportBackup() {
  need();
  const vault = await idbGet("meta", "vault");
  const pack = (r) => ({ id: r.id, iv: C.b64.enc(r.iv), ct: C.b64.enc(r.ct) });
  return JSON.stringify({
    format: "wishcircle-backup", v: 1, exported: new Date().toISOString(),
    vault: { ...vault, id: undefined },
    records: (await idbAll("records")).map(pack),
    images: (await idbAll("images")).map(pack),
  });
}

const ID_RE = /^[0-9a-f]{32}$/;
export async function importBackup(text, passcode) {
  let data;
  try { data = JSON.parse(text); } catch { return "That file isn't a Wish Circle backup."; }
  if (data?.format !== "wishcircle-backup" || data.v !== 1 || !Array.isArray(data.records) || !Array.isArray(data.images)) return "That file isn't a Wish Circle backup.";
  const meta = { v: 1, kdf: data.vault?.kdf, iterations: data.vault?.iterations, salt: data.vault?.salt, iv: data.vault?.iv, wrapped: data.vault?.wrapped };
  // A hostile file could ask for billions of rounds and freeze the app.
  if (meta.kdf !== "PBKDF2-SHA-256" || !(meta.iterations >= 100_000 && meta.iterations <= 10_000_000)) return "That file isn't a Wish Circle backup.";
  let k;
  try { k = await C.openVault(meta, passcode); } catch { k = null; }
  if (!k) return "That passcode doesn't open this backup.";
  const unpack = (r) => {
    if (!ID_RE.test(r?.id) || typeof r.iv !== "string" || typeof r.ct !== "string") throw new Error("bad");
    return { id: r.id, iv: C.b64.dec(r.iv), ct: C.b64.dec(r.ct) };
  };
  let recs, imgs;
  try { recs = data.records.map(unpack); imgs = data.images.map(unpack); } catch { return "This backup file is damaged."; }
  // Prove every record opens before replacing anything.
  for (const r of recs) if (!(await C.openJSON(k, r, "records/" + r.id))) return "This backup file is damaged.";
  await idbClear("records"); await idbClear("images");
  for (const r of recs) await idbPut("records", r);
  for (const r of imgs) await idbPut("images", r);
  await idbPut("meta", { id: "vault", ...meta });
  await idbPut("meta", { id: "throttle", fails: 0, until: 0 });
  lock();
  return null;
}

export async function wipeEverything() {
  lock();
  const d = await db();
  d.close(); dbp = null;
  await new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

async function requestPersistence() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* optional */ }
}
export async function storageInfo() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    return { persisted, usage: est.usage || 0 };
  } catch { return { persisted: false, usage: 0 }; }
}
