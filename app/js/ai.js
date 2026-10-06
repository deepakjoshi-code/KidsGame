// "Build games with Claude AI": the only part of Wish Circle that talks to a server, and only when
// a grown-up has turned it on in Grown-ups (with consent and the family code). The comic's panel
// pictures, shrunk to at most 1024 px, are sent to the family's own comic reader (a small
// Cloudflare Worker, see worker/README.md), which asks Anthropic's Claude to read the words, find
// the characters and plan the game. Nothing else is sent: no names, profiles or other books.
// The answer is checked strictly here before anything is built from it.
import * as store from "./store.js";
import { PLACE_KEYS, CAST_BY_KEY, WEAPONS, ITEMS } from "./catalog.js";
import { newId, MAX_PAGES, MAX_CAST } from "./story.js";

export const DEFAULT_ENDPOINT = "https://api.rawrbooks.com";
export const MAX_PANELS = 60;
export const LONG_SIDE = 1024;
export const QUALITY = 0.82;
const MAX_B64_TOTAL = 11.5 * 1024 * 1024; // the Worker takes 12 MB per request, JSON included
const LEVEL_KINDS = ["journey", "battle", "friends", "climb", "collect"];
const WEAPON_EMOJI = new Set([...WEAPONS.map((w) => w.emoji), "⭐"]);
const ITEM_EMOJI = new Set(ITEMS.map((i) => i.emoji));
const LINE_KINDS = ["speech", "caption", "sfx"];
const ID_RE = /^[a-z0-9-]{1,32}$/;

// ───────────────────────── settings (encrypted, in the store) ─────────────────────────

const OFF = Object.freeze({ enabled: false, endpoint: DEFAULT_ENDPOINT, familyCode: "", consentAt: null });

/** An endpoint the app may call: https (or http on localhost), no credentials, query or hash. */
export function validEndpoint(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username || u.password || u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

/** The grown-up's Claude AI settings. Off until they turn it on. */
export function aiSettings() {
  const r = store.isUnlocked() ? store.list("settings", (s) => s.key === "ai")[0] : null;
  if (!r) return { ...OFF };
  return {
    enabled: r.enabled === true,
    endpoint: validEndpoint(r.endpoint) || DEFAULT_ENDPOINT,
    familyCode: typeof r.familyCode === "string" ? r.familyCode : "",
    consentAt: Number.isFinite(r.consentAt) ? r.consentAt : null,
  };
}

export async function saveAiSettings({ enabled, endpoint, familyCode, consentAt } = {}) {
  const cur = store.list("settings", (s) => s.key === "ai")[0] || { kind: "settings", key: "ai" };
  const next = { ...cur, kind: "settings", key: "ai" };
  if (enabled !== undefined) next.enabled = enabled === true;
  if (endpoint !== undefined) next.endpoint = validEndpoint(endpoint) || DEFAULT_ENDPOINT;
  if (familyCode !== undefined) next.familyCode = String(familyCode || "").trim().slice(0, 200);
  if (consentAt !== undefined) next.consentAt = Number.isFinite(consentAt) ? consentAt : null;
  if (!next.consentAt) next.enabled = false; // never on without consent
  await store.save(next);
  return aiSettings();
}

/** Is Claude AI ready to use (turned on, agreed to, with a family code)? */
export const aiReady = (s = aiSettings()) => !!(s.enabled && s.consentAt && s.familyCode && validEndpoint(s.endpoint));

// ───────────────────────── errors ─────────────────────────

const FRIENDLY = {
  offline: "This device seems to be offline.",
  family_code: "The family code doesn't match the comic reader's.",
  rate_limited: "That's a lot of comics for now. Try again in a while.",
  busy: "Claude is very busy right now.",
  refused: "Claude couldn't make a game from this comic.",
  too_big: "This comic is too big to send in one go.",
  too_long: "This comic was too long for Claude to finish.",
  not_configured: "The comic reader isn't set up yet.",
  origin: "The comic reader doesn't accept this app's address.",
  bad_response: "Claude's answer didn't make sense this time.",
  cancelled: "Cancelled.",
  network: "The comic reader couldn't be reached.",
};
export class AiError extends Error {
  constructor(code, message, status = 0) { super(message || FRIENDLY[code] || "Something went wrong."); this.code = code; this.status = status; }
}
const serverCode = (c) => (c === "bad_output" ? "bad_response" : FRIENDLY[c] ? c : "network");

// ───────────────────────── talking to the comic reader ─────────────────────────

const commonInit = (s, extra = {}) => ({
  method: "POST", mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", ...extra,
  headers: { "x-family-code": s.familyCode, ...(extra.headers || {}) },
});

async function errorFrom(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const code = serverCode(body?.error?.code || (res.status === 401 ? "family_code" : res.status === 429 ? "rate_limited" : "network"));
  return new AiError(code, typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : undefined, res.status);
}
function netError(e, signal) {
  if (signal?.aborted || e?.name === "AbortError") return new AiError("cancelled");
  if (typeof navigator !== "undefined" && navigator.onLine === false) return new AiError("offline");
  return new AiError("network");
}

/** "Test connection" in Grown-ups: checks the endpoint and family code without reading a comic. */
export async function testConnection(s = aiSettings()) {
  const endpoint = validEndpoint(s.endpoint);
  if (!endpoint) return { ok: false, message: "That address doesn't look right." };
  if (!s.familyCode) return { ok: false, message: "Type the family code first." };
  try {
    const res = await fetch(endpoint + "/v1/check", commonInit(s, { signal: AbortSignal.timeout?.(15000) }));
    if (!res.ok) throw await errorFrom(res);
    const body = await res.json().catch(() => ({}));
    return { ok: true, message: body?.mock ? "Connected (test mode, no real Claude)." : "Connected. Claude is ready." };
  } catch (e) {
    const err = e instanceof AiError ? e : netError(e);
    return { ok: false, message: err.message };
  }
}

/**
 * Send the comic's panels to Claude and get back the checked reading.
 * panelBlobs: picture Blobs in reading order (at most MAX_PANELS).
 * onProgress({ stage: "preparing"|"sending"|"reading"|"thinking"|"writing", done, total })
 * → { title, cast, panels, plan, model, usage } (panel numbers are 0-based positions in panelBlobs)
 */
export async function analyzeComic(panelBlobs, { onProgress = () => {}, signal, titleHint = "", settings } = {}) {
  const s = settings || aiSettings();
  if (!aiReady(s)) throw new AiError("not_configured", "Claude AI is turned off.");
  const blobs = [...(panelBlobs || [])].slice(0, MAX_PANELS);
  if (!blobs.length) throw new AiError("too_big", "There are no pictures to read.");
  const tick = (p) => { try { onProgress(p); } catch { /* UI */ } };

  // Shrink every panel; if the whole comic is still too big, shrink again.
  let panels = null;
  for (const [side, q] of [[LONG_SIDE, QUALITY], [896, 0.74], [768, 0.68]]) {
    panels = [];
    let total = 0;
    for (let i = 0; i < blobs.length; i++) {
      if (signal?.aborted) throw new AiError("cancelled");
      tick({ stage: "preparing", done: i, total: blobs.length });
      const jpegBase64 = await jpegBase64Of(blobs[i], side, q);
      total += jpegBase64.length;
      panels.push({ index: i + 1, jpegBase64 }); // "Panel 1" is the first
    }
    if (total <= MAX_B64_TOTAL) break;
    panels = null;
  }
  if (!panels) throw new AiError("too_big");
  tick({ stage: "sending", done: 0, total: blobs.length });

  let res;
  try {
    res = await fetch(validEndpoint(s.endpoint) + "/v1/comic", commonInit(s, {
      signal, headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ panels, titleHint: String(titleHint || "").slice(0, 80) }),
    }));
  } catch (e) { throw netError(e, signal); }
  panels = null; // let the pictures go
  if (!res.ok) throw await errorFrom(res);

  let data;
  if (/application\/x-ndjson/i.test(res.headers.get("content-type") || "")) data = await readLines(res, tick, signal);
  else { try { data = await res.json(); } catch { throw new AiError("bad_response"); } }
  return validateAnalysis(data, blobs.length);
}

async function readLines(res, tick, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { throw new AiError("bad_response"); }
    if (m?.type === "progress") tick({ stage: ["reading", "thinking", "writing"].includes(m.stage) ? m.stage : "reading", done: m.done, total: m.total });
    else if (m?.type === "error") throw new AiError(serverCode(m.error?.code), typeof m.error?.message === "string" ? m.error.message.slice(0, 200) : undefined, m.status || 0);
    else if (m?.type === "result") { const { type, ...rest } = m; result = rest; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > 4 * 1024 * 1024) throw new AiError("bad_response");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf);
  } catch (e) {
    try { reader.cancel(); } catch { /* done */ }
    if (e instanceof AiError) throw e;
    throw netError(e, signal);
  }
  if (!result) throw new AiError(signal?.aborted ? "cancelled" : "network");
  return result;
}

// A picture → base64 JPEG, long side ≤ side px, on a white background.
async function jpegBase64Of(blob, side, quality) {
  const bmp = await createImageBitmap(blob);
  try {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), hgt = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = hgt;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, hgt);
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, w, hgt);
    const out = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", quality));
    c.width = 0; c.height = 0;
    return toBase64(new Uint8Array(await out.arrayBuffer()));
  } finally { bmp.close?.(); }
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ───────────────────────── strict checks on the answer ─────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (what) => { throw new AiError("bad_response", `Claude's answer didn't make sense (${what}).`); };
const str = (v, max, what, { empty = true } = {}) => {
  if (typeof v !== "string" || [...v].length > max || (!empty && !v.trim())) bad(what);
  return v.trim();
};
const keysOnly = (o, keys, what) => { for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${what}: ${k}`); };
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

/**
 * Check the comic reader's answer: types, lengths, ids that point at real characters and panels,
 * boxes inside the picture, and only places / level kinds / weapons the game knows.
 * count = how many panels were sent (numbered 1..count). → a clean copy with panels numbered from 0
 * (positions in what was sent), or throws AiError.
 */
export function validateAnalysis(data, count) {
  if (!isObj(data)) bad("not an object");
  const title = str(data.title, 80, "title");
  const model = data.model === undefined ? "" : str(data.model, 80, "model");
  const usage = isObj(data.usage) ? {
    input_tokens: Number.isFinite(data.usage.input_tokens) ? data.usage.input_tokens : 0,
    output_tokens: Number.isFinite(data.usage.output_tokens) ? data.usage.output_tokens : 0,
    fallback: data.usage.fallback === true,
  } : { input_tokens: 0, output_tokens: 0, fallback: false };
  // The reader numbers panels from 1 (as sent); the answer here numbers them from 0.
  const isPanel = (n) => Number.isInteger(n) && n >= 1 && n <= count;

  if (!Array.isArray(data.cast) || data.cast.length > MAX_CAST) bad("cast");
  const ids = new Set();
  const cast = data.cast.map((c, i) => {
    if (!isObj(c)) bad("cast");
    keysOnly(c, ["id", "name", "role", "big", "kind", "emoji", "appearances"], "cast");
    if (typeof c.id !== "string" || !ID_RE.test(c.id) || ids.has(c.id)) bad(`cast ${i + 1} id`);
    ids.add(c.id);
    if (!["hero", "friend", "villain"].includes(c.role)) bad("role");
    if (typeof c.big !== "boolean") bad("big");
    if (c.kind !== null && !(typeof c.kind === "string" && Object.hasOwn(CAST_BY_KEY, c.kind))) bad("kind");
    const emoji = str(c.emoji, 8, "emoji", { empty: false });
    if (!EMOJI_RE.test(emoji)) bad("emoji");
    if (!Array.isArray(c.appearances) || c.appearances.length > 3) bad("appearances");
    const appearances = c.appearances.map((a) => {
      if (!isObj(a) || !isPanel(a.panel) || !isObj(a.box) || !["left", "right", "front"].includes(a.faces)) bad("appearance");
      keysOnly(a, ["panel", "box", "faces"], "appearance");
      const { x, y, w, h } = a.box;
      if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v)) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) bad("box");
      return { panel: a.panel - 1, box: { x, y, w, h }, faces: a.faces };
    });
    return { id: c.id, name: str(c.name, 40, "name", { empty: false }), role: c.role, big: c.big, kind: c.kind, emoji, appearances };
  });
  const castOf = new Map(cast.map((c) => [c.id, c]));
  const castRef = (v, what) => { if (v !== null && !castOf.has(v)) bad(what); return v; };

  if (!Array.isArray(data.panels) || data.panels.length !== count) bad("panels");
  const panels = data.panels.map((p, i) => {
    if (!isObj(p) || p.index !== i + 1) bad("panel order");
    keysOnly(p, ["index", "part", "place", "chapter", "characters", "narration", "lines"], "panel");
    if (!["cover", "story", "extra"].includes(p.part)) bad("part");
    if (!PLACE_KEYS.includes(p.place)) bad("place");
    if (!Array.isArray(p.characters) || p.characters.length > MAX_CAST) bad("characters");
    if (!Array.isArray(p.lines) || p.lines.length > 30) bad("lines");
    return {
      index: i, part: p.part, place: p.place, chapter: str(p.chapter, 48, "chapter"),
      characters: p.characters.map((c) => castRef(c, "panel character")),
      narration: str(p.narration, 300, "narration"),
      lines: p.lines.map((l) => {
        if (!isObj(l) || !LINE_KINDS.includes(l.kind)) bad("line");
        keysOnly(l, ["speaker", "text", "kind"], "line");
        return { speaker: castRef(l.speaker, "speaker"), text: str(l.text, 400, "line text", { empty: false }), kind: l.kind };
      }),
    };
  });

  if (!Array.isArray(data.plan) || data.plan.length > 3 * count + 20) bad("plan");
  const plan = data.plan.map((st) => {
    if (!isObj(st) || !isPanel(st.panel)) bad("plan step");
    if (st.type === "story") { keysOnly(st, ["type", "panel"], "story step"); return { type: "story", panel: st.panel - 1 }; }
    if (st.type === "chapter") { keysOnly(st, ["type", "panel", "title"], "chapter"); return { type: "chapter", panel: st.panel - 1, title: str(st.title, 48, "chapter title", { empty: false }) }; }
    if (st.type !== "level" || !LEVEL_KINDS.includes(st.kind)) bad("level kind");
    keysOnly(st, ["type", "kind", "panel", "name", "title", "from", "to", "villain", "weapon", "superWeapon", "big", "friends", "item", "home"], "level");
    const lv = { type: "level", kind: st.kind, panel: st.panel - 1, name: str(st.name, 40, "level name", { empty: false }), title: str(st.title, 64, "level title", { empty: false }) };
    for (const k of ["from", "to"]) if (st[k] !== undefined) { if (!PLACE_KEYS.includes(st[k])) bad("level place"); lv[k] = st[k]; }
    if (st.kind === "battle") {
      if (!castOf.has(st.villain) || castOf.get(st.villain).role !== "villain") bad("villain");
      if (!WEAPON_EMOJI.has(st.weapon)) bad("weapon");
      if (st.superWeapon !== undefined && st.superWeapon !== "💣") bad("super weapon");
      Object.assign(lv, { villain: st.villain, weapon: st.weapon, big: castOf.get(st.villain).big });
      if (st.superWeapon) lv.superWeapon = st.superWeapon;
    } else if (st.villain !== undefined || st.weapon !== undefined || st.superWeapon !== undefined) bad("battle fields");
    if (st.kind === "friends") {
      if (!Array.isArray(st.friends) || !st.friends.length || st.friends.length > 4) bad("friends");
      lv.friends = st.friends.map((f) => { if (!castOf.has(f)) bad("friend"); return f; });
    } else if (st.friends !== undefined) bad("friends");
    if (st.kind === "collect") { if (!ITEM_EMOJI.has(st.item)) bad("item"); lv.item = st.item; } else if (st.item !== undefined) bad("item");
    if (st.home !== undefined) { if (st.kind !== "climb" || !["treehouse", "tower"].includes(st.home)) bad("home"); lv.home = st.home; }
    return lv;
  });
  if (!plan.some((s) => s.type === "story")) bad("no story");
  return { title, cast, panels, plan, model, usage };
}

// ───────────────────────── reading → book ─────────────────────────

/**
 * Build a book from the checked reading. panelImage(i) gives the stored image id of panel i.
 * Story panels become the pages (in order), the cover panel the cover; extra panels (credits,
 * slivers) are left out. → { book, appearances: Map<castId, [{ panel, rect, faces }]> }
 */
export function bookFromAnalysis(a, { panelImage, profile = {}, title = "" }) {
  let story = a.panels.filter((p) => p.part === "story");
  if (!story.length) story = a.panels.filter((p) => p.part !== "extra");
  if (!story.length) story = a.panels.slice(0, 1);
  story = story.slice(0, MAX_PAGES);
  const pageOf = new Map(story.map((p, k) => [p.index, k]));
  const coverPanel = a.panels.find((p) => p.part === "cover");

  const ids = new Map(a.cast.map((c) => [c.id, newId()]));
  const cast = a.cast.map((c) => {
    const cat = c.kind ? CAST_BY_KEY[c.kind] : null;
    const name = c.name.trim();
    const words = [...new Set([name.toLowerCase(), ...(cat ? cat.words : [])])].slice(0, 24);
    return {
      id: ids.get(c.id), name, emoji: c.emoji, kind: c.kind || null,
      faces: c.appearances[0]?.faces || cat?.faces || "front", flip: false, imageId: null,
      role: c.role, big: c.role === "villain" && c.big, words,
    };
  });
  if (!cast.length) cast.push({ id: newId(), name: profile.name || "Hero", emoji: profile.avatar || "🧒", kind: null, faces: "front", flip: false, imageId: null, role: "hero", big: false, words: [] });
  if (!cast.some((c) => c.role === "hero")) (cast.find((c) => c.role !== "villain") || cast[0]).role = "hero";
  const hero = cast.find((c) => c.role === "hero");
  const byId = new Map(cast.map((c) => [c.id, c]));
  const who = (v) => (v && ids.has(v) ? ids.get(v) : null);

  const pages = story.map((p) => {
    // Page lines: { who: castId|null, text, kind?: "caption"|"sfx" } (speech has no kind).
    const lines = p.lines.map((l) => {
      const line = { who: who(l.speaker), text: l.text };
      if (l.kind !== "speech") line.kind = l.kind;
      return line;
    });
    const actors = [...new Set([...p.characters.map(who), ...lines.map((l) => l.who)].filter(Boolean))];
    return {
      id: newId(), imageId: panelImage(p.index) || null, place: p.place,
      narration: p.narration,
      lines, actors: actors.length ? actors : [hero.id], action: "none", actionBy: "auto",
    };
  });

  const plan = [];
  for (const st of a.plan) {
    if (!pageOf.has(st.panel)) continue;
    const page = pageOf.get(st.panel);
    const { panel, ...lv } = st;
    if (st.type !== "level") { plan.push({ ...lv, page }); continue; }
    const step = { ...lv, page };
    if (lv.kind === "battle") {
      const v = byId.get(who(lv.villain));
      Object.assign(step, { villain: v.id, villainKey: v.kind, villainName: v.name, villainEmoji: v.emoji, big: v.big });
      if (!step.villainKey) delete step.villainKey;
    }
    if (lv.kind === "friends") step.friends = lv.friends.map(who).filter((id) => id && id !== hero.id);
    plan.push(step);
  }

  const appearances = new Map();
  for (const c of a.cast) appearances.set(ids.get(c.id), c.appearances.map((x) => ({ panel: x.panel, rect: x.box, faces: x.faces })));

  const book = {
    kind: "book", profileId: profile.id, title: (title || a.title || "My Comic").slice(0, 80), author: profile.name || "",
    cast, pages, stars: 0, plays: 0,
    cover: (coverPanel && panelImage(coverPanel.index)) || pages[0]?.imageId || null,
    plan, madeWith: "claude",
  };
  return { book, appearances };
}
