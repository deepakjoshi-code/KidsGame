// Turns a child's written story into a book (pages, cast, places) and a book into a game plan.
// Everything runs on the device: no text ever leaves it.
import { CAST, CAST_BY_KEY, FALLBACK_EMOJI, PLACES, PLACE_KEYS, ACTIONS, ACTION_KEYS, countWords } from "./catalog.js";

const SAY = "said|says|asked|asks|shouted|shouts|yelled|yells|cried|whispered|replied|called|screamed";
export const MAX_PAGES = 40;
export const MAX_CAST = 8;
export const MAX_LEVELS = 6;

export function newId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function normalize(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[“”„]/g, '"').replace(/[‘’]/g, "'")
    .replace(/^\s*\*+/gm, "")
    .replace(/^\s*page\s*\d+\s*[:.)-]?\s*$/gim, "\n\n")
    .trim();
}

function sentences(s) {
  return s.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) || [];
}

// Split raw text into page-sized chunks.
export function splitPages(text) {
  const t = normalize(text);
  if (!t) return [];
  let chunks = t.split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  if (chunks.length < 2) {
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      chunks = [];
      for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2).join("\n"));
    } else {
      const ss = sentences(t);
      chunks = [];
      for (let i = 0; i < ss.length; i += 2) chunks.push(ss.slice(i, i + 2).join(" "));
    }
  }
  return chunks.slice(0, MAX_PAGES);
}

// Pull dialogue out of one chunk. Returns { narration, lines: [{ name, text }] }.
export function parseChunk(chunk) {
  const lines = [];
  const rest = [];
  for (let raw of chunk.split("\n")) {
    raw = raw.trim();
    if (!raw) continue;
    const colon = raw.match(/^([A-Z][\p{L}'-]*(?:\s[A-Z][\p{L}'-]*)?)\s*[:：]\s*(.+)$/u);
    if (colon) { lines.push({ name: colon[1], text: stripQuotes(colon[2]) }); continue; }
    let s = raw;
    const after = new RegExp(`"([^"]+)"\\s*,?\\s*(?:${SAY})\\s+(?:the\\s+)?([A-Z]?[\\p{L}-]+)`, "giu");
    const before = new RegExp(`([A-Z][\\p{L}-]+)\\s+(?:${SAY})\\s*,?\\s*"([^"]+)"`, "gu");
    s = s.replace(after, (_, q, n) => { lines.push({ name: cap(n), text: q.trim() }); return " "; });
    s = s.replace(before, (_, n, q) => { lines.push({ name: cap(n), text: q.trim() }); return " "; });
    // A lone quote with no speaker belongs to whoever spoke last (or the hero later).
    s = s.replace(/"([^"]{2,})"/g, (_, q) => { lines.push({ name: null, text: q.trim() }); return " "; });
    s = s.replace(/\s+/g, " ").trim();
    if (s && !/^[.,!?;:\s]+$/.test(s)) rest.push(s);
  }
  return { narration: rest.join(" "), lines };
}

function stripQuotes(s) { return s.trim().replace(/^"(.*)"$/, "$1").trim(); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// Which catalog character does a name or phrase refer to?
export function matchCatalog(phrase) {
  const p = phrase.toLowerCase();
  for (const c of CAST) if (c.words.some((w) => w === p || p === w + "s")) return c;
  return null;
}

function resolveSpeaker(name, text) {
  const direct = matchCatalog(name);
  if (direct) return direct;
  const nm = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pats = [
    new RegExp(`${nm},?\\s+(?:the|a|an)\\s+(?:\\p{L}+\\s+)?([\\p{L}-]+)`, "iu"),
    new RegExp(`(?:a|an|the)\\s+(?:\\p{L}+\\s+)?([\\p{L}-]+)\\s+(?:named|called)\\s+${nm}`, "iu"),
    new RegExp(`${nm}\\s+(?:was|is)\\s+(?:a|an)\\s+(?:\\p{L}+\\s+)?([\\p{L}-]+)`, "iu"),
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) { const c = matchCatalog(m[1]); if (c) return c; }
  }
  return null;
}

export function detectPlace(text, fallback = "forest") {
  let best = null, bestN = 0;
  for (const k of PLACE_KEYS) { const n = countWords(text, PLACES[k].words); if (n > bestN) { best = k; bestN = n; } }
  return best || fallback;
}

export function detectAction(text) {
  let best = null, bestN = 0;
  for (const k of ACTION_KEYS) { const n = countWords(text, ACTIONS[k].words); if (n > bestN) { best = k; bestN = n; } }
  return best;
}

// Build a full book object from text. Photos (if any) are attached to pages in order by the caller.
export function buildBook(text, { title = "My Story", author = "" } = {}) {
  const chunks = splitPages(text);
  const all = normalize(text);
  const parsed = chunks.map(parseChunk);

  // 1. Cast from speakers, in order of appearance.
  const cast = [];
  const byName = new Map();
  const add = (name, cat, extra = {}) => {
    const key = name.toLowerCase();
    if (byName.has(key) || cast.length >= MAX_CAST) return byName.get(key);
    const member = {
      id: newId(), name,
      emoji: cat ? cat.emoji : FALLBACK_EMOJI[cast.length % FALLBACK_EMOJI.length],
      kind: cat ? cat.key : null,
      faces: cat ? cat.faces : "front",
      flip: false, imageId: null,
      role: cat && cat.villain ? "villain" : "friend",
      big: !!(cat && cat.big),
      words: cat ? cat.words : [],
      ...extra,
    };
    cast.push(member); byName.set(key, member);
    if (cat) for (const w of cat.words) if (!byName.has(w)) byName.set(w, member);
    return member;
  };
  for (const p of parsed) for (const l of p.lines) if (l.name) {
    const lower = l.name.toLowerCase();
    if (byName.has(lower)) continue;
    const cat = resolveSpeaker(l.name, all);
    // A speaker like "Daddy" and the word "dad" are the same character.
    const existing = cat && cast.find((c) => c.kind === cat.key && c.name.toLowerCase() !== lower && cat.words.includes(c.name.toLowerCase()));
    if (existing) { byName.set(lower, existing); continue; }
    add(l.name, cat);
  }
  // 2. Characters only mentioned in narration ("a velociraptor", "his pet lion").
  for (const c of CAST) {
    if (cast.some((m) => m.kind === c.key)) continue;
    if (countWords(all, c.words) > 0) add(c.label, c);
  }
  if (!cast.length) add("Hero", null);
  // 3. Roles: the first non-villain is the hero.
  const hero = cast.find((c) => c.role !== "villain") || cast[0];
  hero.role = "hero";

  // 4. Pages.
  let place = "forest";
  let lastSpeaker = hero;
  const pages = parsed.map((p, i) => {
    const pageText = chunks[i];
    place = detectPlace(pageText, place);
    const lines = p.lines.map((l) => {
      const who = l.name ? byName.get(l.name.toLowerCase()) || lastSpeaker : lastSpeaker;
      lastSpeaker = who;
      return { who: who.id, text: l.text };
    });
    const actors = cast.filter((c) =>
      lines.some((l) => l.who === c.id) || countWords(pageText, [c.name.toLowerCase(), ...c.words]) > 0
    ).map((c) => c.id);
    return {
      id: newId(), imageId: null, place,
      narration: p.narration, lines,
      actors: actors.length ? actors : [hero.id],
      action: detectAction(pageText) || "none",
    };
  });

  // A battle with no villain needs someone to battle.
  if (pages.some((p) => p.action === "battle") && !cast.some((c) => c.role === "villain")) {
    const m = add("Monster", CAST_BY_KEY.monster);
    if (m) for (const p of pages) if (p.action === "battle") p.actors.push(m.id);
  }
  return {
    kind: "book", title: title.trim() || "My Story", author: author.trim(),
    cast, pages, stars: 0, plays: 0, cover: pages[0]?.imageId || null,
  };
}

// A game plan: story cards with levels slotted in where the story has action.
export function planGame(book) {
  const steps = [];
  let levels = 0, last = null, lastAt = -9;
  book.pages.forEach((p, i) => {
    steps.push({ type: "story", page: i });
    const a = p.action && p.action !== "none" ? p.action : null;
    if (!a || levels >= MAX_LEVELS) return;
    if (a === last && i - lastAt < 3) return;
    steps.push({ type: "level", kind: a, page: i });
    levels++; last = a; lastAt = i;
  });
  if (levels === 0) {
    steps.splice(Math.min(1, steps.length), 0, { type: "level", kind: "journey", page: 0 });
    levels++;
  }
  if (steps[steps.length - 1].type !== "level" || steps[steps.length - 1].kind !== "celebrate") {
    steps.push({ type: "level", kind: "celebrate", page: Math.max(0, book.pages.length - 1) });
  }
  return steps;
}

export const EXAMPLE_STORY = `Pip the bunny lived in a little house by the park.
Pip: I want to go on an adventure!

Pip ran into the forest with her friend Owl.
Owl: Look, a shiny path! Let's go!

They found a cave full of gold coins and gems.
Pip: Treasure! Let's collect it all!

Oh no! A dragon woke up. ROAR!
Owl: Let's fight it with magic!

The dragon ran away. Pip and Owl climbed the ladder up to the tree house.
Pip: Hooray! We made it home!`;
