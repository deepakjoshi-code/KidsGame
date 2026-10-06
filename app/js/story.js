// Turns a child's written story into a book (pages, cast, places) and a book into a game plan.
// This planning runs on the device. (Books from uploaded comics may arrive with a plan from Claude; see ai.js.)
import { CAST, CAST_BY_KEY, FALLBACK_EMOJI, PLACES, PLACE_KEYS, ACTIONS, ACTION_KEYS, WEAPONS, ITEMS, EXTRA_VILLAINS, PLACE_CHAPTER, PLACE_RUN, countWords } from "./catalog.js";

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
    // "Pip said" / "The lion said" / "she said" before the quote.
    const before = new RegExp(`(?:\\b[Tt]he\\s+)?\\b([\\p{L}][\\p{L}-]*)\\s+(?:${SAY})\\s*,?\\s*:?\\s*"([^"]+)"`, "gu");
    s = s.replace(after, (_, q, n) => { lines.push({ name: speaker(n), text: q.trim() }); return " "; });
    s = s.replace(before, (_, n, q) => { lines.push({ name: speaker(n), text: q.trim() }); return " "; });
    // A lone quote with no speaker belongs to whoever spoke last (or the hero later).
    s = s.replace(/"([^"]{2,})"/g, (_, q) => { lines.push({ name: null, text: q.trim() }); return " "; });
    s = s.replace(/\s+/g, " ").trim();
    if (s && !/^[.,!?;:\s]+$/.test(s)) rest.push(s);
  }
  return { narration: rest.join(" "), lines };
}

// Pronouns aren't characters: "she said" belongs to whoever spoke last.
const PRONOUNS = new Set(["he", "she", "it", "they", "we", "i", "you", "everyone", "someone"]);
const speaker = (n) => (PRONOUNS.has(n.toLowerCase()) ? null : cap(n));
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
  // Each pattern is tried without and then with one describing word ("Pip the bunny", "Pip the little bunny").
  const adj = ["", "(?:\\p{L}+\\s+)"];
  const pats = adj.flatMap((A) => [
    new RegExp(`${nm},?\\s+(?:the|a|an)\\s+${A}([\\p{L}-]+)`, "iu"),
    new RegExp(`(?:a|an|the)\\s+${A}([\\p{L}-]+)\\s+(?:named|called)\\s+${nm}`, "iu"),
    new RegExp(`${nm}\\s+(?:was|is)\\s+(?:a|an)\\s+${A}([\\p{L}-]+)`, "iu"),
  ]);
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
  // 1b. Named characters introduced in narration ("Pip the bunny", "a dog named Max"), even if they never speak.
  const NOT_NAMES = new Set(["then", "when", "and", "but", "so", "suddenly", "after", "finally", "one", "once", "there", "here", "now", "soon", "later", "next", "meanwhile", "today", "the", "a", "an", "oh", "look", "all", "every", "it", "he", "she", "they", "we", "i", "you"]);
  const named = [...all.matchAll(/\b([A-Z][\p{L}'-]+),?\s+(?:the|a|an|was|is)\s/gu), ...all.matchAll(/(?:named|called)\s+([A-Z][\p{L}'-]+)/gu)];
  for (const m of named) {
    const name = m[1];
    if (NOT_NAMES.has(name.toLowerCase()) || byName.has(name.toLowerCase()) || matchCatalog(name)) continue;
    const cat = resolveSpeaker(name, all);
    if (cat) add(name, cat);
  }
  // 2. Characters only mentioned in narration ("a velociraptor", "his pet lion").
  for (const c of CAST) {
    if (cast.some((m) => m.kind === c.key)) continue;
    if (countWords(all, c.words) > 0) add(c.label, c);
  }
  if (!cast.length) add("Hero", null);
  // 3. Roles: the hero is the first non-villain the story mentions.
  const lowerAll = all.toLowerCase();
  const firstSeen = (c) => Math.min(...[c.name, ...c.words].map((w) => { const i = lowerAll.indexOf(w.toLowerCase()); return i < 0 ? Infinity : i; }));
  const hero = cast.filter((c) => c.role !== "villain").sort((a, b) => firstSeen(a) - firstSeen(b))[0] || cast[0];
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

// A game plan for a book: every book is mapped the way the hand-made "Mousie" game maps its comic.
// A book may carry a plan proposed when it was made (book.plan); it is checked and repaired first.
export function planGame(book) {
  if (!book || !book.pages || !book.pages.length) return [];
  return book.plan ? normalizePlan(book, book.plan) : mapComic(book);
}

/* ================================================================================================
   mapComic: comic → game, the way the parent's hand-made "Mousie" game does it.

   The game is the comic's panels in order (one story step per panel, its words read aloud), in
   named chapters, with a level slotted in right AFTER the panel where the action is decided:
     1. Setting off ("we're going on an adventure", "let's go")  → a run toward the NEXT place.
     2. Each distinct villain → its own battle, after the panel where the heroes decide/prepare
        to fight it ("we should fight it", "let's fight it with bombs", "let's do it").
     3. Friends showing off / new friends arriving ("look at my pet lion") → one parade after the
        last of those panels, with one button per friend from that stretch.
     4. Going home ("let's go home") → a climb (home up a tree/tower/ladder) or a run home.
     (+ a treasure hunt when the heroes find and collect treasure.)
   No generic fireworks at the end: the last panels play, then "The End".
   Pages may come from OCR: noisy text, unknown speakers (who: null), sound words like "ROOR!".
   A page's `action`, when the child changed it in the editor, overrides all of this.
   ============================================================================================== */

// Words the rules below look for. Typos in the comic's text are snapped to these (and to the
// cast's names), so "figth" still reads as "fight".
const RULE_WORDS = `adventure adventures trip journey quest hike explore exploring expedition going lets fight fights
  fought fighting attack battle beat defeat stop zap shoot blast bomb bombs arrow arrows destroy chase scare kick punch should
  must think died dead defeated won win away boom kaboom hooray hurray yay yah gone vanished destroyed home house treehouse
  tree ladder climb climbed climbing climbs tower nest walk walked walking run ran race raced drive drove ride rode sail
  sailed swim swam fly flew rocket spaceship look meet check friend friends play together pet treasure collect collected
  find found grab pick picked gather inside velociraptor tyrannosaurus dinosaur dragon monster ready wonderful perfect
  everyone sure what think`;
// Everyday words that sit one letter away from a rule word and must never be "fixed".
const COMMON = new Set(`flight fright light lights might night right sight tight bright there these those three their where
  about after again always before being could every first great happy little never other people place small something
  still thing think thought under until water which while would write sleep smile story today tomorrow watch wanted doing
  saying playing plays played sorry hello thank thanks please start stand sends helps hours mouth match catch fights
  winner wings window finds finally fixed point drink dream dress drove green grass groan grown phone plane plant
  climber homes horses houses rides tries cried dried fried prize price trick truth trust track trace train crown
  clown brown frown flower floor flies files fires fined lines likes lives loves moves waves wakes walls calls balls
  bells hills mills pills tells yells smell spell shell shall chase chose those whose house mouse moose loose goose`.split(/\s+/).filter(Boolean));

const SFX = new Set(["zoom", "vroom", "beep", "honk", "woof", "meow", "tweet", "chirp", "roar", "roor", "boom", "bang", "pow",
  "splash", "hehe", "haha", "hihi", "hiss", "buzz", "neenaw", "naw", "nee", "chomp", "grr", "rawr", "ding", "whoosh", "swoosh",
  "splat", "crash", "oink", "moo", "quack", "ribbit", "yah", "yay", "wow", "woo", "hooray", "kaboom", "zap", "bam", "oops", "eek"]);
const ROAR_RE = /^(r+o+a*r+|ro+r+|ra+w+r+|g+r+r+|roo+a*r+|rawr+)$/;
const POSSESSIVE = new Set(["my", "your", "his", "her", "our", "their", "pet"]);
const FIGHT_VERBS = new Set(["fight", "attack", "battle", "beat", "defeat", "stop", "zap", "shoot", "blast", "bomb", "destroy", "chase", "scare", "kick", "punch"]);
const BATTLE_WORDS = new Set(["fight", "fights", "fought", "fighting", "attack", "attacked", "battle", "bomb", "bombs", "arrow", "arrows", "sword", "zap", "blast", "defeat", "defeated", "punch", "kick", "shoot", "destroy"]);
const OUTCOME_RE = /\b(died|dies|dead|defeated|won|win|beat it|ran away|runs away|flew away|swam away|run away|boom|kaboom|hooray|hurray|yay|yah|did it|is gone|was gone|vanished|destroyed|the end)\b/;
const HORTATIVE_RE = /\b(lets|let us|should|must|have to|need to|will|well|can|gotta|time to|going to|ready to|try to)\b/;
const SETOFF_RES = [
  /\b(going|go|goes|went|off|gone) on (an |a |our |my |another |a big |big |a new )?(adventure|adventures|trip|journey|quest|hike|expedition)\b/,
  /\blets (go|set off|explore|walk|run|hike|race|fly|sail|swim|head out|get going|move|ride|drive)\b/,
  /\b(off we go|here we go|we set off|lets start|adventure begins|lets begin|go exploring|went exploring)\b/,
];
const NOT_SETOFF_AFTER = /^(inside|in|into|in there|home|back|to sleep|to bed|fight|and fight|get it|get them|play|together)\b/;
const PERMISSION_RE = /\b(can|may|could) (i|we)\b|\b(want|wants|wanted|wish|wanna|would like) to\b|\bwanna\b/;
const TRAVEL_RE = /\b(walked|ran|went|walk|run|travelled|traveled|flew|sailed|swam|hiked|rode|drove|marched|headed) (in|into|to|through|across|over|off to|down|up|out to)\b/;
const GOHOME_RE = /\b(go|going|goes|went|head|heading|headed|walk|walked|run|ran|fly|flew|race|raced|hurry|sail|sailed|swim|swam|drive|drove|ride|rode|get|getting|zoom|march|time to go)( back)?( to)?( the| our| my)? (home|treehouse|tree house)\b|\bback home\b(?! (at|safe))|\bhome time\b/;
const ARRIVE_HOME_RE = /\b(made it home|made it back|back home|home at last|home sweet home|we are home|were home|got home|safe at home|arrived home|home safe|treehouse|tree house|at home)\b/;
const UP_RE = /\b(treehouse|tree house|ladder|climb|climbed|climbs|climbing|tower|up the tree|nest|attic|bunk)\b/;
const GROUND_RE = /\b(walk|walked|walking|ran|run|running|drive|drove|car|bus|train|ride|rode|riding|sail|sailed|boat|ship|swim|swam|swimming|fly|flew|flying|rocket|spaceship|race|raced|bike)\b/;
const RUN_HOME_PLACES = new Set(["city", "beach", "desert", "ocean", "space", "sky"]);
const SHOWOFF_RE = /\b(look at|see|meet|this is|check out|say hi to|say hello to|here is|heres|look its|its) (my|our) ((?:new |pet |little |big |best |cool |red |shiny |baby |super )*)([a-z0-9]+)(?: ([a-z0-9]+))?/g;
const FRIEND_RE = /\b(new friend|new friends|be my friend|be friends|make friends|lets play|play together|wanna play|want to play|play too|nice to meet you|meet my|can i play|join us|come with us|best friends)\b/;
const COLLECT_RE = /\b(collect|collected|find|found|grab|pick|picked|gather|get|treasure|full of)\b/;
const KIND_ORDER = { journey: 0, collect: 1, battle: 2, friends: 3, climb: 4, celebrate: 5 };
const KEEP_PRIORITY = { collect: 0, celebrate: 0, journey: 1, friends: 2, climb: 3, battle: 4 };

// Damerau (optimal string alignment) distance, small strings only.
function osa(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

// Lowercase, apostrophes and hyphens out ("let's" → "lets", "T-Rex" → "trex"), OCR digits in words fixed.
function rawTokens(text) {
  return String(text || "").toLowerCase()
    .replace(/[‘’`´']/g, "").replace(/(\p{L})-(?=\p{L})/gu, "$1")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map((t) => (/\p{L}/u.test(t) ? t.replace(/0/g, "o").replace(/1/g, "l").replace(/5/g, "s") : t));
}
const wordKey = (w) => rawTokens(w).join(" ");

function makeVocab(book) {
  const vocab = new Set(RULE_WORDS.split(/\s+/).filter(Boolean));
  const add = (w) => { for (const t of rawTokens(w)) if (t.length > 2) vocab.add(t); };
  for (const c of [...CAST, ...EXTRA_VILLAINS]) c.words.forEach(add);
  for (const k of PLACE_KEYS) PLACES[k].words.forEach(add);
  for (const w of [...WEAPONS, ...ITEMS]) w.words.forEach(add);
  for (const k of ACTION_KEYS) ACTIONS[k].words.forEach(add);
  for (const c of book.cast || []) { add(c.name || ""); (c.words || []).forEach(add); }
  const memo = new Map();
  const fix = (t) => {
    if (vocab.has(t) || t.length < 5 || COMMON.has(t) || /\d/.test(t)) return t;
    if (memo.has(t)) return memo.get(t);
    const max = t.length >= 8 ? 2 : 1;
    let best = t, bestD = max + 1, tie = false;
    for (const w of vocab) {
      if (w.length < 4 || (t.length < 7 && w[0] !== t[0])) continue;
      const d = osa(t, w, max);
      if (d < bestD) { best = w; bestD = d; tie = false; } else if (d === bestD && w !== best) tie = true;
    }
    const out = bestD <= max && !tie ? best : t;
    memo.set(t, out);
    return out;
  };
  return { fix };
}

// One utterance (a speech line or the narration) → sentences of canonical tokens.
function sentencesOf(text, fix) {
  const out = [];
  const parts = String(text || "").replace(/\r?\n/g, " ").split(/([.!?]+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const toks = rawTokens(parts[i]).map(fix);
    if (!toks.length) continue;
    out.push({ s: toks.join(" "), toks, q: /\?/.test(parts[i + 1] || "") });
  }
  return out;
}

const isSfxToken = (t) => SFX.has(t) || /(\p{L})\1\1/u.test(t) || ROAR_RE.test(t);
const sfxOnly = (toks) => toks.length > 0 && toks.length <= 6 && toks.every(isSfxToken);
const roarOnly = (toks) => toks.length > 0 && toks.every((t) => ROAR_RE.test(t));

function analysePages(book, fix) {
  return book.pages.map((p, i) => {
    const utter = [];
    if (p.narration) utter.push({ who: null, narr: true, sents: sentencesOf(p.narration, fix) });
    for (const l of p.lines || []) if (l && l.text) utter.push({ who: l.who || null, narr: false, sents: sentencesOf(l.text, fix) });
    const sents = utter.flatMap((u) => u.sents);
    const toks = sents.flatMap((s) => s.toks);
    const text = " " + sents.map((s) => s.s).join(" . ") + " ";
    return {
      i, page: p, place: PLACES[p.place] ? p.place : null, utter, sents, toks, text,
      speakers: new Set(utter.filter((u) => u.who).map((u) => u.who)),
      actors: new Set(p.actors || []),
      allSfx: toks.length > 0 && sfxOnly(toks),
      roar: utter.some((u) => !u.narr && u.sents.length && roarOnly(u.sents.flatMap((s) => s.toks))),
      outcome: OUTCOME_RE.test(text),
    };
  });
}

// Where (and how) does a character get mentioned on a page? Returns { any, plain }.
function mentions(pa, words) {
  let any = false, plain = false;
  for (const w of words) {
    if (!w) continue;
    const re = new RegExp(`(?:^| )${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?(?= |$)`, "g");
    for (const s of pa.sents) {
      for (const m of s.s.matchAll(re)) {
        any = true;
        const before = s.s.slice(0, m.index).trim().split(" ").pop();
        if (!POSSESSIVE.has(before)) plain = true;
      }
    }
  }
  return { any, plain };
}

const fightIntent = (pa) => pa.sents.some((s) => {
  const h = s.s.match(HORTATIVE_RE);
  if (!h) return false;
  return s.toks.slice(s.s.slice(0, h.index).split(" ").filter(Boolean).length).some((t) => FIGHT_VERBS.has(t));
});
const doIt = (pa) => /\blets do (it|this)\b|\blets get (it|him|her|them)\b/.test(pa.text);
const weaponWords = (pa) => WEAPONS.some((w) => w.words.some((x) => pa.toks.includes(x)));
const isPrep = (pa) => !pa.outcome && (fightIntent(pa) || doIt(pa) || (weaponWords(pa) && /\b(lets|ready|look)\b/.test(pa.text)));

function setOff(pa) {
  for (const s of pa.sents) {
    if (s.q) continue;
    for (const re of SETOFF_RES) {
      const m = s.s.match(re);
      if (!m) continue;
      if (PERMISSION_RE.test(s.s.slice(0, m.index + m[0].length))) continue;
      const after = s.s.slice(m.index + m[0].length).trim();
      if (re === SETOFF_RES[1] && NOT_SETOFF_AFTER.test(after)) continue;
      if (s.toks.some((t) => FIGHT_VERBS.has(t))) continue;
      if (/\bhome\b/.test(after.split(" ").slice(0, 3).join(" "))) continue;
      return { sentence: s.s, after };
    }
  }
  return null;
}
const goHome = (pa) => GOHOME_RE.test(pa.text);

function weaponsOf(pas) {
  const text = pas.map((p) => p.text).join(" ");
  const found = [];
  for (const w of WEAPONS) {
    let at = Infinity;
    for (const x of w.words) { const m = text.match(new RegExp(`(?:^| )${x}(?= |$)`)); if (m && m.index < at) at = m.index; }
    if (at < Infinity) found.push({ e: w.emoji, at });
  }
  found.sort((a, b) => a.at - b.at);
  const bomb = found.some((f) => f.e === "💣");
  const main = found.find((f) => f.e !== "💣");
  return { weapon: main ? main.e : bomb ? "💣" : null, superWeapon: bomb ? "💣" : null };
}

export function mapComic(book) {
  const pagesIn = (book && book.pages) || [];
  if (!pagesIn.length) return [];
  const n = pagesIn.length;
  const cast = (book.cast || []).filter((c) => c && c.id);
  const { fix } = makeVocab(book);
  const P = analysePages(book, fix);
  // Pages from OCR may have no place yet: carry the last one along.
  let lastPlace = P.find((p) => p.place)?.place || "forest";
  for (const p of P) { if (p.place) lastPlace = p.place; else p.place = lastPlace; }
  // A one-panel blip ("the dragon flew away" → sky) isn't a new place.
  for (let i = 1; i + 1 < P.length; i++) {
    if (P[i].place !== P[i - 1].place && P[i + 1].place !== P[i].place && !setOff(P[i]) && !goHome(P[i])) P[i].place = P[i - 1].place;
  }
  // "Let's go to the park!" / "Let's go home": when only the talking names the new place, they're
  // still where they were until the level takes them there.
  const headingTo = new Map();
  for (let i = 1; i < P.length; i++) {
    const pa = P[i];
    if (pa.place === P[i - 1].place || !(setOff(pa) || goHome(pa))) continue;
    const said = pa.utter.filter((u) => !u.narr).flatMap((u) => u.sents.map((x) => x.s)).join(" . ");
    const told = pa.utter.filter((u) => u.narr).flatMap((u) => u.sents.map((x) => x.s)).join(" . ");
    if (detectPlace(said, null) === pa.place && detectPlace(told, null) !== pa.place) { headingTo.set(i, pa.place); pa.place = P[i - 1].place; }
  }

  const hero = cast.find((c) => c.role === "hero") || cast.find((c) => c.role !== "villain") || null;
  const heroId = hero ? hero.id : null;
  const castWords = new Map(cast.map((c) => [c.id, [...new Set([wordKey(c.name || ""), ...(c.words || []).map(wordKey)])].filter((w) => w.length > 1)]));

  // Who is on each page: speakers, the page's actors, and anyone the words mention.
  const presence = new Map(); // id → [{ i, plain }]
  for (const c of cast) {
    const list = [];
    for (const pa of P) {
      const m = mentions(pa, castWords.get(c.id));
      const spoke = pa.speakers.has(c.id);
      if (spoke || pa.actors.has(c.id) || m.any) list.push({ i: pa.i, plain: spoke || m.plain || (pa.actors.has(c.id) && !m.any) });
    }
    presence.set(c.id, list);
  }
  const presentAt = (id, i) => (presence.get(id) || []).some((x) => x.i === i);

  // ---- villains: catalog villains, cast villains, roarers/attackers, and monsters only named in the text.
  const villains = new Map(); // vid → { id, castId, key, name, big, emoji }
  for (const c of cast) {
    if (c.id === heroId) continue;
    const cat = CAST_BY_KEY[c.kind];
    let bad = c.role === "villain" || !!(cat && cat.villain);
    if (!bad) {
      bad = P.some((pa) => pa.utter.some((u) => u.who === c.id && u.sents.length && roarOnly(u.sents.flatMap((s) => s.toks))));
      if (!bad) bad = castWords.get(c.id).some((w) => P.some((pa) => new RegExp(`(?:^| )${w} (roared|roars|attacked|attacks|bit|chased|growled)\\b`).test(pa.text)));
    }
    if (bad) villains.set(c.id, { id: c.id, castId: c.id, key: c.kind || null, name: c.name, big: !!(c.big || (cat && cat.big)), emoji: c.emoji });
  }
  const textVillains = [...CAST.filter((c) => c.villain), ...EXTRA_VILLAINS];
  for (const v of textVillains) {
    if (cast.some((c) => c.kind === v.key || (c.words || []).some((w) => v.words.includes(w)))) continue;
    const words = v.words.filter((w) => w !== "giant").map(wordKey);
    const pres = P.filter((pa) => mentions(pa, words).any).map((pa) => ({ i: pa.i, plain: true }));
    if (!pres.length) continue;
    const vid = "~" + v.key;
    villains.set(vid, { id: vid, castId: null, key: v.key, name: v.label, big: !!v.big, emoji: v.emoji });
    presence.set(vid, pres);
  }
  // A roar from someone we can't name belongs to the newest villain on the scene.
  const vFirst = new Map();
  const villainOrder = () => [...villains.keys()].filter((v) => vFirst.has(v)).sort((a, b) => vFirst.get(b) - vFirst.get(a));

  // ---- levels, keyed by the page they follow
  const levels = []; // { kind, page, ...fields, auto: true }
  const at = (i) => levels.filter((l) => l.page === i);
  const fought = new Map();
  let active = null;
  for (const pa of P) {
    const here = [...villains.keys()].filter((v) => presentAt(v, pa.i));
    for (const v of here) if (!vFirst.has(v)) vFirst.set(v, pa.i);
    if (pa.roar && !here.length && active) here.push(active);
    const fresh = here.filter((v) => !fought.has(v)).sort((a, b) => vFirst.get(b) - vFirst.get(a))[0];
    if (fresh) active = fresh;
    if (!active || fought.has(active)) continue;
    const near = here.includes(active) || (pa.i > 0 && presentAt(active, pa.i - 1));
    if (!(fightIntent(pa) || (doIt(pa) && near))) continue;
    let end = pa.i;
    while (end + 1 < n && isPrep(P[end + 1]) && ![...villains.keys()].some((v) => v !== active && !vFirst.has(v) && presentAt(v, end + 1))) end++;
    fought.set(active, { decide: pa.i, end });
  }
  // A villain nobody decided to fight still gets a battle: before the panel where it's beaten,
  // or after the last panel it's in.
  for (const v of villainOrder().reverse()) {
    if (fought.has(v)) continue;
    const first = vFirst.get(v);
    const out = P.find((pa) => pa.i > first && pa.outcome && (presentAt(v, pa.i) || presentAt(v, pa.i - 1)));
    const pres = presence.get(v).map((x) => x.i);
    const end = out ? out.i - 1 : Math.max(...pres);
    fought.set(v, { decide: end, end });
  }
  for (const [v, f] of fought) {
    const V = villains.get(v);
    const win = P.slice(vFirst.get(v), Math.min(n, f.end + 2));
    let { weapon, superWeapon } = weaponsOf(win);
    if (!weapon) weapon = weaponsOf(P).weapon && weaponsOf(P).weapon !== "💣" ? weaponsOf(P).weapon : "⭐";
    levels.push({ kind: "battle", page: f.end, villain: V.castId, villainKey: V.key, villainName: V.name, villainEmoji: V.emoji, big: V.big,
      weapon, superWeapon, name: V.big ? `The Mighty ${V.name.replace(/^the\s+/i, "")}` : V.name.replace(/^the\s+/i, ""), auto: true });
  }

  // ---- setting off: a run through this place toward the next one
  const nextPlace = (i) => { for (let j = i + 1; j < n; j++) if (P[j].place !== P[i].place) return P[j].place; return null; };
  const journey = (i, sentence) => {
    let to = null, from = P[i].place;
    if (sentence) {
      const dest = detectPlace(sentence, null);
      if (dest && dest !== "home") to = dest;
    }
    if (to && to === from && i > 0 && P[i - 1].place !== to) from = P[i - 1].place;
    if ((!to || to === from) && headingTo.has(i) && headingTo.get(i) !== from) to = headingTo.get(i);
    if (!to || to === from) to = nextPlace(i) || from;
    return { kind: "journey", page: i, from, to, name: PLACE_RUN[from] || "Run", auto: true };
  };
  let lastSetOff = -9;
  for (const pa of P) {
    const so = setOff(pa);
    if (!so || pa.i - lastSetOff < 2) continue;
    levels.push(journey(pa.i, so.after));
    lastSetOff = pa.i;
  }
  if (lastSetOff < 0) {
    // No one said "let's go": a walk into a new place, or an adventure someone wished for.
    const walk = P.find((pa) => pa.i > 0 && pa.sents.some((s) => TRAVEL_RE.test(s.s)));
    const wish = P.find((pa) => /\b(adventure|adventures|journey|trip|quest)\b/.test(pa.text));
    if (walk) { const j = journey(walk.i - 1, null); j.to = walk.place; levels.push(j); }
    else if (wish && nextPlace(wish.i)) levels.push(journey(wish.i, null));
  }
  const firstLevel = () => Math.min(n, ...levels.map((l) => l.page));

  // ---- going home
  const lastBattle = Math.max(-1, ...levels.filter((l) => l.kind === "battle").map((l) => l.page));
  const upCue = P.some((pa) => UP_RE.test(pa.text));
  let homeLevel = null, homeStart = -1;
  const homeCandidate = P.find((pa) => goHome(pa) && pa.i > lastBattle && (pa.i > firstLevel() || pa.i >= n / 2));
  const homeKind = (from, stretch) => {
    if (upCue) return "climb";
    if (stretch.some((pa) => GROUND_RE.test(pa.text)) || RUN_HOME_PLACES.has(from)) return "journey";
    return "climb";
  };
  const homeOf = () => (P.some((pa) => /\b(tower|castle)\b/.test(pa.text) && (goHome(pa) || pa.place === "home")) ? "tower" : "treehouse");
  if (homeCandidate) {
    homeStart = homeCandidate.i;
    let e = homeStart;
    while (e + 1 < n && (goHome(P[e + 1]) || P[e + 1].allSfx)) e++;
    const from = P[e].place;
    const kind = homeKind(from, P.slice(homeStart, e + 1));
    homeLevel = kind === "climb"
      ? { kind, page: e, home: homeOf(), from, to: "home", name: "Climb Home", auto: true }
      : { kind, page: e, from, to: "home", name: "Run Home", auto: true };
    levels.push(homeLevel);
  } else {
    // They come home at the end without anyone saying so: the way home goes before those panels.
    let k = n;
    while (k - 1 > 0 && (P[k - 1].place === "home" || ARRIVE_HOME_RE.test(P[k - 1].text))) k--;
    const away = P.slice(0, k).some((pa) => pa.place !== "home");
    if (k < n && k > 0 && away && k - 1 >= Math.max(lastBattle, firstLevel() < n ? firstLevel() : 0)) {
      const from = P[k - 1].place === "home" ? (P.slice(0, k).reverse().find((pa) => pa.place !== "home")?.place || "forest") : P[k - 1].place;
      const kind = homeKind(from, P.slice(k));
      homeLevel = kind === "climb"
        ? { kind, page: k - 1, home: homeOf(), from, to: "home", name: "Climb Home", auto: true }
        : { kind, page: k - 1, from, to: "home", name: "Run Home", auto: true };
      levels.push(homeLevel);
    }
  }

  // ---- friends: a parade after the panels where friends show off or arrive
  const villainIds = new Set([...villains.values()].map((v) => v.castId).filter(Boolean));
  const goodCast = cast.filter((c) => c.id !== heroId && !villainIds.has(c.id));
  const firstPlain = (id) => (presence.get(id) || []).find((x) => x.plain)?.i ?? Infinity;
  const levelPages = () => new Set(levels.map((l) => l.page));
  const showOff = (pa) => {
    const out = [];
    for (const s of pa.sents) for (const m of s.s.matchAll(SHOWOFF_RE)) {
      const cands = [m[5] ? `${m[4]} ${m[5]}` : null, m[4], m[5]].filter(Boolean);
      let hit = null;
      out.phrase = true;
      for (const w of cands) {
        const near = (x) => x === w || x + "s" === w || (w.length >= 4 && x.length >= 4 && osa(w, x, 1) <= 1);
        hit = goodCast.find((c) => castWords.get(c.id).some(near)) || null;
        if (hit) { out.push({ id: hit.id }); break; }
        const cat = CAST.find((c) => !c.villain && c.words.some((x) => wordKey(x) === w));
        if (cat) { hit = cat; out.push({ guest: { key: cat.key, name: cat.label, emoji: cat.emoji } }); break; }
      }
    }
    return out;
  };
  const triggers = (pa) => !!setOff(pa) || goHome(pa) || fightIntent(pa) || [...villains.keys()].some((v) => presentAt(v, pa.i));
  const advStart = firstLevel();
  const arrivalsAt = (i) => goodCast.filter((c) => firstPlain(c.id) === i && i > advStart).map((c) => c.id);
  const anchor = (pa) => !triggers(pa) && (showOff(pa).phrase || FRIEND_RE.test(pa.text));
  const parades = [];
  for (let a = 0; a < n; a++) {
    if (!anchor(P[a])) continue;
    let s = a;
    for (let k = a - 1; k >= Math.max(0, a - 3); k--) {
      if (triggers(P[k]) || P[k].outcome || levelPages().has(k)) break;
      if (arrivalsAt(k).length) s = k;
    }
    let e = a;
    const group = new Set();
    const grow = (i) => { showOff(P[i]).forEach((x) => x.id && group.add(x.id)); arrivalsAt(i).forEach((id) => group.add(id)); };
    for (let i = s; i <= a; i++) grow(i);
    while (e + 1 < n && !levelPages().has(e) && !triggers(P[e + 1])) {
      const pb = P[e + 1];
      const who = [...pb.speakers, ...pb.actors].filter((id) => id !== heroId);
      const friendish = anchor(pb) || arrivalsAt(pb.i).length || (pb.allSfx && !pb.roar) || (who.length && who.every((id) => group.has(id)));
      if (!friendish) break;
      e++; grow(e);
    }
    const shown = [], guests = [];
    for (let i = s; i <= e; i++) for (const x of showOff(P[i])) {
      if (x.id && !shown.includes(x.id)) shown.push(x.id);
      if (x.guest && !guests.some((g) => g.key === x.guest.key)) guests.push(x.guest);
    }
    const arrived = [];
    for (let i = s; i <= e; i++) for (const id of arrivalsAt(i)) if (!shown.includes(id) && !arrived.includes(id)) arrived.push(id);
    const before = Math.min(s, advStart < n ? advStart : 0);
    const companions = goodCast.filter((c) => !shown.includes(c.id) && !arrived.includes(c.id) &&
      (presence.get(c.id) || []).some((x) => x.plain && x.i < s && x.i >= before)).map((c) => c.id);
    const friends = [...shown, ...arrived, ...companions].slice(0, 4);
    const g = guests.slice(0, Math.max(0, 4 - friends.length));
    if (friends.length + g.length) {
      const lv = { kind: "friends", page: e, friends, name: "Play with Friends", auto: true };
      if (g.length) lv.guests = g;
      levels.push(lv);
      parades.push({ start: s, end: e, title: arrived.length === 1 ? "A new friend" : arrived.length > 1 ? "New friends" : "Friends!" });
    }
    a = e;
  }

  // ---- treasure: found and collected
  let lastCollect = -9;
  for (const pa of P) {
    const item = ITEMS.find((it) => it.words.some((w) => pa.toks.includes(w)));
    if (!item || !COLLECT_RE.test(pa.text) || pa.i - lastCollect < 4 || at(pa.i).length) continue;
    levels.push({ kind: "collect", page: pa.i, item: item.emoji, name: "Treasure Hunt", auto: true });
    lastCollect = pa.i;
  }

  // ---- what the child chose in the editor wins
  for (const pa of P) {
    const chosen = explicitAction(pa.page, cast);
    if (!chosen) continue;
    for (const l of at(pa.i)) levels.splice(levels.indexOf(l), 1);
    if (chosen === "none") continue;
    levels.push(explicitLevel(chosen, pa, { P, n, villains, presentAt, vFirst, goodCast, heroId, nextPlace, levels }));
  }

  // ---- at most MAX_LEVELS: the child's own choices and battles stay longest
  while (levels.length > MAX_LEVELS) {
    const drop = levels.filter((l) => l.auto).sort((a, b) => KEEP_PRIORITY[a.kind] - KEEP_PRIORITY[b.kind] || b.page - a.page)[0];
    if (!drop) break;
    levels.splice(levels.indexOf(drop), 1);
  }
  // A book with no action at all still gets one run.
  if (!levels.length) levels.push(journey(0, null));

  // ---- chapters
  const chapterAt = new Map();
  const battleAfter = new Set(levels.filter((l) => l.kind === "battle").map((l) => l.page));
  const villainStart = new Map(); // page → title
  for (const l of levels) {
    if (l.kind !== "battle") continue;
    const vid = l.villain || (l.villainKey ? "~" + l.villainKey : null);
    let cs = vFirst.has(vid) ? vFirst.get(vid) : l.page;
    if (P[cs].outcome && cs < l.page) cs++;
    if (!villainStart.has(cs)) villainStart.set(cs, l.name);
  }
  const homeAfterPage = homeLevel && levels.includes(homeLevel) ? homeLevel.page + 1 : -1;
  let hadBattle = false;
  for (let i = 0; i < n; i++) {
    let title = null;
    if (i === 0) title = PLACE_CHAPTER[P[0].place] || "Our story";
    if (i === homeAfterPage && i < n) title = "Home!";
    else if (i === homeStart && homeLevel && levels.includes(homeLevel)) title = "Time to go home";
    else if (parades.some((p) => p.start === i)) title = parades.find((p) => p.start === i).title;
    else if (i > 0 && villainStart.has(i) && hadBattle) title = villainStart.get(i);
    else if (i > 0 && P[i].place !== P[i - 1].place) title = PLACE_CHAPTER[P[i].place] || null;
    if (title) { chapterAt.set(i, title); hadBattle = false; }
    if (battleAfter.has(i)) hadBattle = true;
  }

  // ---- the plan
  levels.sort((a, b) => a.page - b.page || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const steps = [];
  let num = 0;
  for (let i = 0; i < n; i++) {
    if (chapterAt.has(i)) steps.push({ type: "chapter", title: chapterAt.get(i), page: i });
    steps.push({ type: "story", page: i });
    for (const l of levels.filter((x) => x.page === i)) {
      num++;
      const { auto, ...rest } = l;
      const step = { type: "level", ...rest, title: `Level ${num} · ${l.name}` };
      if (!auto) step.chosen = true;
      for (const k of Object.keys(step)) if (step[k] === null || step[k] === undefined) delete step[k];
      steps.push(step);
    }
  }
  return steps;
}

// A page's game, when the child picked it in the editor (it differs from what the words say).
// `actionBy: "child"` / `"auto"` on a page settles it either way.
function explicitAction(p, cast) {
  if (!p || p.action === undefined || p.action === null || p.actionBy === "auto") return null;
  const a = p.action === "none" || ACTION_KEYS.includes(p.action) ? p.action : null;
  if (!a) return null;
  if (p.actionBy === "child") return a;
  const names = new Map(cast.map((c) => [c.id, c.name || ""]));
  const plain = [p.narration || "", ...(p.lines || []).map((l) => l?.text || "")].join("\n");
  const named = [p.narration || "", ...(p.lines || []).map((l) => `${names.get(l?.who) || ""}: ${l?.text || ""}`)].join("\n");
  const autos = new Set([detectAction(plain) || "none", detectAction(named) || "none"]);
  return autos.has(a) ? null : a;
}

function explicitLevel(kind, pa, ctx) {
  const { P, n, villains, presentAt, vFirst, goodCast, heroId, nextPlace } = ctx;
  const i = pa.i;
  const base = { kind, page: i, auto: false };
  if (kind === "battle") {
    const here = [...villains.values()].filter((v) => presentAt(v.id, i));
    const past = [...villains.values()].filter((v) => vFirst.has(v.id) && vFirst.get(v.id) <= i).sort((a, b) => vFirst.get(b.id) - vFirst.get(a.id));
    const V = here[0] || past[0] || [...villains.values()][0] || { castId: null, key: "monster", name: "Monster", big: false, emoji: "👾" };
    for (const l of ctx.levels.filter((l) => l.auto && l.kind === "battle" && (l.villain || null) === V.castId && l.villainKey === V.key)) ctx.levels.splice(ctx.levels.indexOf(l), 1);
    const { weapon, superWeapon } = weaponsOf(P.slice(Math.max(0, i - 2), Math.min(n, i + 2)));
    return { ...base, villain: V.castId, villainKey: V.key, villainName: V.name, villainEmoji: V.emoji, big: V.big, weapon: weapon || "⭐", superWeapon,
      name: V.big ? `The Mighty ${V.name}` : V.name };
  }
  if (kind === "friends") {
    const ids = [...pa.speakers, ...pa.actors].filter((id) => id !== heroId && goodCast.some((c) => c.id === id));
    const friends = [...new Set([...ids, ...goodCast.map((c) => c.id)])].slice(0, 4);
    return { ...base, friends, name: "Play with Friends" };
  }
  if (kind === "journey") return { ...base, from: P[i].place, to: nextPlace(i) || P[i].place, name: PLACE_RUN[P[i].place] || "Run" };
  if (kind === "climb") {
    const home = GOHOME_RE.test(pa.text) || i >= n - 2;
    return home ? { ...base, home: "treehouse", from: P[i].place, to: "home", name: "Climb Home" } : { ...base, from: P[i].place, name: "Climb Up" };
  }
  if (kind === "collect") {
    const item = ITEMS.find((it) => it.words.some((w) => pa.toks.includes(w)));
    return { ...base, item: item ? item.emoji : null, name: "Treasure Hunt" };
  }
  return { ...base, name: ACTIONS[kind]?.label || "Party" };
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

/* ================================================================================================
   normalizePlan: a plan proposed from outside (e.g. Claude reading every panel) → the exact steps
   the game plays. Every panel exactly once and in order; chapters and levels kept where they were
   proposed; anything invalid fixed or dropped. Nothing usable → the rule-based mapComic(book).
   ============================================================================================== */
const KIND_ALIAS = {
  journey: "journey", run: "journey", race: "journey", travel: "journey", walk: "journey", swim: "journey", fly: "journey",
  battle: "battle", fight: "battle", boss: "battle", raptor: "battle", trex: "battle",
  friends: "friends", parade: "friends", play: "friends", meet: "friends",
  climb: "climb", ladder: "climb",
  collect: "collect", treasure: "collect", hunt: "collect",
};
const HOMES = new Set(["treehouse", "tower", "house"]);
const LEVEL_PREFIX = /^\s*level\s*\d+\s*[·:.\-–—]?\s*/i;

function emojiFrom(v, list) {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const hit = list.find((w) => w.emoji === s || w.words.includes(s.toLowerCase()) || w.words.some((x) => s.toLowerCase() === x + "s"));
  return hit ? hit.emoji : null;
}

export function normalizePlan(book, proposed) {
  const pages = (book && book.pages) || [];
  const n = pages.length;
  if (!n) return [];
  let list = proposed;
  if (list && !Array.isArray(list) && typeof list === "object" && Array.isArray(list.steps)) list = list.steps;
  if (!Array.isArray(list)) return mapComic(book);
  const cast = (book.cast || []).filter((c) => c && c.id);
  const hero = cast.find((c) => c.role === "hero") || null;
  const findCast = (v) => {
    if (typeof v !== "string" || !v.trim()) return null;
    const s = v.trim(), low = s.toLowerCase(), key = wordKey(s);
    return cast.find((c) => c.id === s) || cast.find((c) => (c.name || "").toLowerCase() === low)
      || cast.find((c) => c.kind === low || (c.words || []).some((w) => wordKey(w) === key)) || null;
  };
  const pageOf = (v, clamp) => {
    if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
    if (!Number.isInteger(v)) return null;
    if (v >= 0 && v < n) return v;
    return clamp ? Math.max(0, Math.min(n - 1, v)) : null;
  };
  const placeOr = (v, dflt) => (typeof v === "string" && PLACES[v.trim().toLowerCase()] ? v.trim().toLowerCase() : dflt);
  const placeAt = (i) => (PLACES[pages[i]?.place] ? pages[i].place : "forest");

  const chapters = new Map(); // page → title
  const levels = []; // { page, step }
  let cur = -1;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const type = String(raw.type || (raw.kind || raw.level ? "level" : raw.story !== undefined ? "story" : "")).toLowerCase();
    if (type === "story") {
      const p = pageOf(raw.page, false);
      if (p !== null) cur = p;
      continue;
    }
    if (type === "chapter") {
      const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      if (!title) continue;
      const p = pageOf(raw.page, false) ?? Math.min(n - 1, cur + 1);
      chapters.set(p, title);
      continue;
    }
    if (type !== "level") continue;
    const kind = KIND_ALIAS[String(raw.kind || raw.level || "").toLowerCase()];
    if (!kind) continue; // unknown kinds and generic fireworks are dropped
    const page = pageOf(raw.page, true) ?? Math.max(0, cur);
    const step = repairLevel(kind, raw, page, { cast, hero, findCast, placeOr, placeAt, pages });
    if (step) levels.push({ page, step });
  }
  if (!levels.length) return mapComic(book);

  const steps = [];
  let num = 0;
  for (let i = 0; i < n; i++) {
    if (chapters.has(i)) steps.push({ type: "chapter", title: chapters.get(i), page: i });
    steps.push({ type: "story", page: i });
    for (const { page, step } of levels) {
      if (page !== i) continue;
      num++;
      const out = { type: "level", ...step, page: i, title: `Level ${num} · ${step.name}` };
      for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
      steps.push(out);
    }
  }
  return steps;
}

function repairLevel(kind, raw, page, { cast, hero, findCast, placeOr, placeAt }) {
  const given = typeof raw.title === "string" ? raw.title.replace(LEVEL_PREFIX, "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const named = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  const label = named || given;
  const step = { kind };
  if (raw.chosen) step.chosen = true;
  if (kind === "battle") {
    let c = findCast(raw.villain) || findCast(raw.villainName);
    if (c && c.id === hero?.id) c = null;
    let key = c?.kind || null, name = c?.name || null, emoji = c?.emoji || null;
    if (!c) {
      const cat = [...CAST, ...EXTRA_VILLAINS].find((x) => x.villain && [raw.villainKey, raw.villain, raw.villainName].some((v) => typeof v === "string" && (x.key === v.toLowerCase() || x.words.includes(v.toLowerCase()) || x.label.toLowerCase() === v.toLowerCase())));
      const anyVillain = cast.find((x) => x.role === "villain");
      if (cat) { key = cat.key; name = cat.label; emoji = cat.emoji; }
      else if (anyVillain) { c = anyVillain; key = c.kind; name = c.name; emoji = c.emoji; }
      else { key = "monster"; name = typeof raw.villainName === "string" && raw.villainName.trim() ? raw.villainName.trim().slice(0, 30) : "Monster"; emoji = "👾"; }
    }
    const cat = CAST_BY_KEY[key] || EXTRA_VILLAINS.find((x) => x.key === key);
    const big = !!(c?.big || cat?.big || raw.big === true);
    const words = [raw.weapon, raw.superWeapon, ...(Array.isArray(raw.weapons) ? raw.weapons : [])].map((w) => emojiFrom(w, WEAPONS)).filter(Boolean);
    let weapon = emojiFrom(raw.weapon, WEAPONS);
    let superWeapon = emojiFrom(raw.superWeapon, WEAPONS);
    if (!superWeapon && words.includes("💣")) superWeapon = "💣";
    if (!weapon || (weapon === "💣" && words.some((w) => w !== "💣"))) weapon = words.find((w) => w !== "💣") || weapon || "⭐";
    const plainName = String(name).replace(/^the\s+/i, "");
    Object.assign(step, { villain: c?.id || null, villainKey: key, villainName: name, villainEmoji: emoji, big, weapon, superWeapon,
      name: label || (big ? `The Mighty ${plainName}` : plainName) });
    return step;
  }
  if (kind === "friends") {
    const ids = [];
    for (const f of Array.isArray(raw.friends) ? raw.friends : []) {
      const c = findCast(f);
      if (c && c.id !== hero?.id && c.role !== "villain" && !ids.includes(c.id)) ids.push(c.id);
    }
    if (!ids.length) for (const c of cast) if (c.id !== hero?.id && c.role !== "villain" && ids.length < 4) ids.push(c.id);
    if (!ids.length) return null;
    return Object.assign(step, { friends: ids.slice(0, 4), name: label || "Play with Friends" });
  }
  const from = placeOr(raw.from, placeAt(page));
  if (kind === "journey") {
    const to = placeOr(raw.to, from);
    return Object.assign(step, { from, to, name: label || (to === "home" && from !== "home" ? "Run Home" : PLACE_RUN[from] || "Run") });
  }
  if (kind === "climb") {
    const toHome = raw.to === "home" || HOMES.has(raw.home) || /home/i.test(label);
    if (toHome) return Object.assign(step, { from, to: "home", home: HOMES.has(raw.home) ? raw.home : "treehouse", name: label || "Climb Home" });
    return Object.assign(step, { from, name: label || "Climb Up" });
  }
  // collect
  return Object.assign(step, { item: emojiFrom(raw.item, ITEMS), name: label || "Treasure Hunt" });
}
