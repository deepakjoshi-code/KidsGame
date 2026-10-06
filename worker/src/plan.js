// Claude's reading of a comic → the Worker's answer. Everything is checked and repaired here
// (ids that point nowhere, boxes off the picture, unknown keys, too many levels), so the app gets
// a clean, self-consistent result. The game plan is built in the app's step shape:
//   { type: "chapter", title, panel } · { type: "story", panel } · { type: "level", kind, panel, ... }
// where `panel` is the panel number the app sent (the app turns it into its page index).
import {
  PLACE_KEYS, CAST_KEYS, WEAPON_EMOJI, ITEM_EMOJI, LEVEL_KINDS, LINE_KINDS, PARTS, ROLES, FACES,
  MAX_CAST, MAX_LEVELS, MAX_APPEARANCES,
} from "./schema.js";
import { CAST_BY_KEY } from "../../app/js/catalog.js";

const LIMITS = { title: 80, name: 40, chapter: 48, levelName: 40, text: 400, narration: 300, lines: 24 };
const KIND_ORDER = { journey: 0, collect: 1, battle: 2, friends: 3, climb: 4 };
const KEEP = { collect: 0, journey: 1, friends: 2, climb: 3, battle: 4 }; // lowest is dropped first

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
/** A clean single-line string: control characters out, spaces tidied, length capped. */
export function cleanText(v, max) {
  if (typeof v !== "string") return "";
  const s = v.normalize("NFC").replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return [...s].slice(0, max).join("");
}
export const slug = (v) => (typeof v === "string" ? v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) : "");
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
export function cleanEmoji(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && [...s].length <= 8 && EMOJI_RE.test(s) && !/[\p{L}\p{N}]/u.test(s.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")) ? s : null;
}

/**
 * @param {unknown} raw Claude's JSON
 * @param {{index:number,width:number,height:number}[]} input the panels that were sent, in order
 * @returns {{ title, cast, panels, plan }} or throws Error("bad_output")
 */
export function shapeReading(raw, input) {
  if (!isObj(raw) || !Array.isArray(raw.panels)) throw new Error("bad_output");
  const dims = new Map(input.map((p) => [p.index, p]));
  const order = input.map((p) => p.index);

  // ---- cast
  const cast = [];
  const idMap = new Map(); // Claude's id → clean id
  for (const c of arr(raw.cast)) {
    if (!isObj(c) || cast.length >= MAX_CAST) continue;
    const name = cleanText(c.name, LIMITS.name);
    let id = slug(c.id) || slug(name);
    if (!id || !name) continue;
    if (idMap.has(c.id) || idMap.has(id)) continue;
    let n = 2;
    while (cast.some((x) => x.id === id)) id = `${slug(c.id) || slug(name)}-${n++}`;
    idMap.set(c.id, id);
    idMap.set(id, id);
    const kind = CAST_KEYS.includes(c.kind) ? c.kind : null;
    const role = ROLES.includes(c.role) ? c.role : "friend";
    const appearances = [];
    for (const a of arr(c.appearances)) {
      if (appearances.length >= MAX_APPEARANCES || !isObj(a)) continue;
      const box = normBox(a.box, dims.get(a.panel));
      if (!box || appearances.some((x) => x.panel === a.panel)) continue;
      appearances.push({ panel: a.panel, box, faces: FACES.includes(a.faces) ? a.faces : (CAST_BY_KEY[kind]?.faces || "front") });
    }
    cast.push({
      id, name, role, big: role === "villain" && c.big === true, kind,
      emoji: cleanEmoji(c.emoji) || CAST_BY_KEY[kind]?.emoji || (role === "villain" ? "👾" : "⭐"),
      appearances,
    });
  }
  // Exactly one hero: the first one named, else the first good character.
  const heroes = cast.filter((c) => c.role === "hero");
  heroes.slice(1).forEach((c) => { c.role = "friend"; });
  if (!heroes.length) { const h = cast.find((c) => c.role !== "villain"); if (h) h.role = "hero"; }
  const castId = (v) => (typeof v === "string" && idMap.has(v) ? idMap.get(v) : (typeof v === "string" && idMap.has(slug(v)) ? idMap.get(slug(v)) : null));

  // ---- panels (one per panel sent, in order; anything missing is filled in)
  const byNo = new Map();
  for (const p of raw.panels) if (isObj(p) && dims.has(p.panel) && !byNo.has(p.panel)) byNo.set(p.panel, p);
  let place = "forest", chapter = "";
  const firstPlace = order.map((i) => byNo.get(i)?.place).find((x) => PLACE_KEYS.includes(x));
  if (firstPlace) place = firstPlace;
  const panels = order.map((index, k) => {
    const p = byNo.get(index) || {};
    place = PLACE_KEYS.includes(p.place) ? p.place : place;
    chapter = cleanText(p.chapter, LIMITS.chapter) || chapter;
    const part = PARTS.includes(p.part) ? p.part : (k === 0 && order.length > 1 ? "cover" : "story");
    const lines = [];
    for (const l of arr(p.lines)) {
      if (!isObj(l) || lines.length >= LIMITS.lines) continue;
      const text = cleanText(l.text, LIMITS.text);
      if (!text) continue;
      lines.push({ speaker: castId(l.speaker), text, kind: LINE_KINDS.includes(l.kind) ? l.kind : "speech" });
    }
    const characters = [...new Set(arr(p.characters).map(castId).filter(Boolean))];
    const narration = cleanText(p.narration, LIMITS.narration);
    return { index, part, place, chapter, characters, narration, lines };
  });
  let story = panels.filter((p) => p.part === "story");
  if (!story.length) { panels.forEach((p) => { if (p.part !== "cover" || panels.length === 1) p.part = "story"; }); story = panels.filter((p) => p.part === "story"); }
  if (!story.length) { panels[0].part = "story"; story = [panels[0]]; }
  if (!story[0].chapter) story[0].chapter = "Our story";

  // ---- levels
  const pos = new Map(order.map((i, k) => [i, k]));
  const storyAt = (panelNo) => {
    // A level after a panel that isn't a story panel moves back to the nearest story panel before it.
    if (!pos.has(panelNo)) return null;
    for (let k = pos.get(panelNo); k >= 0; k--) if (panels[k].part === "story") return panels[k].index;
    return null;
  };
  const villains = cast.filter((c) => c.role === "villain");
  const levels = [];
  for (const l of arr(raw.levels)) {
    if (!isObj(l) || !LEVEL_KINDS.includes(l.kind)) continue;
    const after = storyAt(l.after_panel);
    if (after === null) continue;
    const here = panels[pos.get(after)].place;
    const name = cleanText(l.name, LIMITS.levelName);
    const lv = { kind: l.kind, panel: after };
    if (l.kind === "journey") {
      lv.from = PLACE_KEYS.includes(l.from) ? l.from : here;
      lv.to = PLACE_KEYS.includes(l.to) ? l.to : lv.from;
      lv.name = name || (lv.to === "home" ? "Run Home" : "Run");
    } else if (l.kind === "climb") {
      lv.from = PLACE_KEYS.includes(l.from) ? l.from : here;
      lv.to = "home";
      lv.home = l.home === "tower" ? "tower" : "treehouse";
      lv.name = name || "Climb Home";
    } else if (l.kind === "battle") {
      const v = cast.find((c) => c.id === castId(l.villain) && c.role === "villain") || null;
      if (!v && !villains.length) continue;
      const V = v || villains[0];
      if (levels.some((x) => x.kind === "battle" && x.villain === V.id)) continue;
      lv.villain = V.id;
      lv.weapon = WEAPON_EMOJI.includes(l.weapon) ? l.weapon : "⭐";
      lv.superWeapon = l.super_weapon === "💣" || l.weapon === "💣" ? "💣" : null;
      lv.big = V.big;
      lv.name = name || (V.big ? `The Mighty ${V.name}` : V.name);
    } else if (l.kind === "friends") {
      const hero = cast.find((c) => c.role === "hero");
      lv.friends = [...new Set(arr(l.friends).map(castId).filter((id) => id && id !== hero?.id && cast.find((c) => c.id === id)?.role !== "villain"))].slice(0, 4);
      if (!lv.friends.length) continue;
      lv.name = name || "Play with Friends";
    } else if (l.kind === "collect") {
      lv.item = ITEM_EMOJI.includes(l.item) ? l.item : "💰";
      lv.name = name || "Treasure Hunt";
    }
    if (levels.some((x) => x.panel === lv.panel && x.kind === lv.kind)) continue;
    levels.push(lv);
  }
  while (levels.length > MAX_LEVELS) {
    const drop = [...levels].sort((a, b) => KEEP[a.kind] - KEEP[b.kind] || pos.get(b.panel) - pos.get(a.panel))[0];
    levels.splice(levels.indexOf(drop), 1);
  }

  // ---- the plan: chapters, every story panel in order, levels right after their panel
  levels.sort((a, b) => pos.get(a.panel) - pos.get(b.panel) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const plan = [];
  let lastChapter = null, num = 0;
  for (const p of story) {
    if (p.chapter && p.chapter !== lastChapter) { plan.push({ type: "chapter", title: p.chapter, panel: p.index }); lastChapter = p.chapter; }
    plan.push({ type: "story", panel: p.index });
    for (const lv of levels.filter((x) => x.panel === p.index)) {
      num++;
      const step = { type: "level", ...lv, title: `Level ${num} · ${lv.name}` };
      for (const k of Object.keys(step)) if (step[k] === null || step[k] === undefined) delete step[k];
      plan.push(step);
    }
  }

  const title = cleanText(raw.title, LIMITS.title) || "My Comic";
  return { title, cast, panels, plan };
}

/** [x0,y0,x1,y1] in panel pixels → { x, y, w, h } in 0–1, clamped; null if unusable. */
export function normBox(box, dim) {
  if (!dim || !Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  let [x0, y0, x1, y1] = box;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const c = (v) => Math.max(0, Math.min(1, v));
  const nx0 = c(x0 / dim.width), ny0 = c(y0 / dim.height), nx1 = c(x1 / dim.width), ny1 = c(y1 / dim.height);
  if (nx1 - nx0 < 0.02 || ny1 - ny0 < 0.02) return null;
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(nx0), y: r(ny0), w: r(nx1 - nx0), h: r(ny1 - ny0) };
}
