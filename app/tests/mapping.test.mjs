// Ground truth for comic → game mapping: the parent's hand-made "Mousie" game (tests/fixtures/
// mousie-reference.json is its STEPS list). mapComic is never told where the levels go; it has to
// find them from the panels' words, the way the reference does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapComic, planGame, normalizePlan, buildBook } from "../js/story.js";
import { ACTION_KEYS, CAST_BY_KEY } from "../js/catalog.js";

const REF = JSON.parse(readFileSync(new URL("./fixtures/mousie-reference.json", import.meta.url), "utf8"));
const PLACE_OF = { "At home": "home", "In the forest": "forest", "The cave": "cave", "The Mighty T-Rex": "cave", "A new friend": "forest", "Time to go home": "forest", "Home!": "home" };
const CAST = [
  ["mousie", "Mousie", "mouse", "hero"], ["daddy", "Daddy", "dad", "friend"], ["birdie", "Birdie", "bird", "friend"],
  ["raptor", "Velociraptor", "raptor", "villain"], ["trex", "T-Rex", "trex", "villain"], ["snake", "Snake", "snake", "friend"],
  ["lion", "Lion", "lion", "friend"], ["truck", "Fire truck", "firetruck", "friend"],
].map(([id, name, kind, role]) => {
  const c = CAST_BY_KEY[kind];
  return { id, name, emoji: c.emoji, kind, faces: c.faces, flip: false, imageId: null, role, big: !!c.big, words: c.words };
});
const ID_OF = Object.fromEntries(CAST.map((c) => [c.name, c.id]));

// A word is "mentioned" on a page like buildBook does it: whole words of the name or catalog words.
function mentioned(text) {
  const t = ` ${text.toLowerCase().replace(/[^a-z-]+/g, " ")} `;
  return CAST.filter((c) => [c.name.toLowerCase(), ...c.words].some((w) => t.includes(` ${w} `) || t.includes(` ${w}s `))).map((c) => c.id);
}

// One page per reference story step: its lines, speakers mapped to the cast, place from its chapter.
function refBook({ speakers = true, noise = null } = {}) {
  const pages = [];
  for (const s of REF) {
    if (!s.story) continue;
    const lines = s.lines.map(([who, text], k) => ({ who: speakers ? ID_OF[who] || null : null, text: noise ? noise(text, pages.length, k) : text }));
    const all = lines.map((l) => l.text).join(" ");
    const actors = [...new Set([...lines.map((l) => l.who).filter(Boolean), ...mentioned(all)])];
    pages.push({ id: s.story, imageId: null, place: PLACE_OF[s.ch], narration: "", lines, actors: actors.length ? actors : ["mousie"], action: "none", actionBy: "auto", key: s.story });
  }
  return { kind: "book", title: "Mousie", author: "Samar", cast: CAST, pages, stars: 0, plays: 0, cover: null };
}

// The reference, as (kind, after-which-panel, name) and chapter starts.
const REF_KIND = { run: "journey", raptor: "battle", trex: "battle", parade: "friends", climb: "climb" };
function refLevels() {
  const out = [];
  let last = null;
  for (const s of REF) {
    if (s.story) last = s.story;
    if (s.level) out.push({ kind: REF_KIND[s.level], after: last, name: s.ch });
  }
  return out;
}
function refChapters() {
  const out = [];
  let ch = null;
  for (const s of REF) if (s.story && s.ch !== ch) { ch = s.ch; out.push({ title: ch, at: s.story }); }
  return out;
}
const levelsOf = (book, plan) => plan.filter((s) => s.type === "level").map((s) => ({ ...s, after: book.pages[s.page].key }));
const chaptersOf = (book, plan) => plan.filter((s) => s.type === "chapter").map((s) => ({ title: s.title, at: book.pages[s.page].key }));

function checkShape(book, plan) {
  const stories = plan.filter((s) => s.type === "story").map((s) => s.page);
  assert.deepEqual(stories, book.pages.map((_, i) => i), "every panel once, in order");
  for (const s of plan) {
    assert.ok(["chapter", "story", "level"].includes(s.type), s.type);
    assert.ok(Number.isInteger(s.page) && s.page >= 0 && s.page < book.pages.length);
    if (s.type === "level") {
      assert.ok(ACTION_KEYS.includes(s.kind), s.kind);
      assert.match(s.title, /^Level \d+ · \S/);
      if (s.villain) assert.ok(book.cast.some((c) => c.id === s.villain));
      for (const f of s.friends || []) assert.ok(book.cast.some((c) => c.id === f));
    }
    if (s.type === "chapter") assert.equal(typeof s.title, "string");
  }
  assert.ok(!plan.some((s) => s.type === "level" && s.kind === "celebrate"), "no generic fireworks");
}

test("Mousie: mapComic reproduces the reference levels, after the same panels", () => {
  const book = refBook();
  const plan = mapComic(book);
  checkShape(book, plan);
  const got = levelsOf(book, plan);
  const want = refLevels();
  assert.deepEqual(got.map((l) => [l.kind, l.after]), want.map((l) => [l.kind, l.after]));
  assert.deepEqual(got.map((l) => l.title), want.map((l) => l.name.replace("Play with Friends", "Play with Friends")));

  const [run, raptor, trex, parade, climb] = got;
  assert.equal(run.after, "adventure");
  assert.equal(run.from, "forest");
  assert.equal(run.to, "cave");
  assert.equal(raptor.villain, "raptor");
  assert.equal(raptor.weapon, "🏹");
  assert.equal(raptor.superWeapon, undefined);
  assert.equal(raptor.big, false);
  assert.equal(trex.villain, "trex");
  assert.equal(trex.weapon, "🏹");
  assert.equal(trex.superWeapon, "💣");
  assert.equal(trex.big, true);
  assert.deepEqual(parade.friends, ["lion", "truck", "snake", "birdie"]);
  assert.equal(climb.to, "home");
  assert.equal(climb.home, "treehouse");
});

test("Mousie: chapters start where the reference's do", () => {
  const book = refBook();
  assert.deepEqual(chaptersOf(book, mapComic(book)), refChapters());
});

test("Mousie: planGame uses the same mapping", () => {
  const book = refBook();
  assert.deepEqual(planGame(book), mapComic(book));
});

// Light OCR-like noise: casing, missing punctuation, apostrophes, a few typos.
const TYPOS = [["adventure", "adventrue"], ["Velociraptor", "Velociraptr"], ["should fight", "should figth"], ["fire truck", "fire truk"], ["arrows", "arrrows"], ["Let's", "Lets"], ["We're", "Were"], ["home", "home"]];
function noisy(text, page, k) {
  let t = text;
  for (const [a, b] of TYPOS) t = t.split(a).join(b);
  const n = page * 3 + k;
  if (n % 3 === 0) t = t.toUpperCase();
  else if (n % 3 === 1) t = t.toLowerCase();
  if (n % 2 === 0) t = t.replace(/[.!?,']/g, "");
  return t;
}

test("robustness: no speakers + OCR-like noise still gives the same level sequence", () => {
  const book = refBook({ speakers: false, noise: noisy });
  assert.ok(book.pages.every((p) => p.lines.every((l) => l.who === null)));
  const plan = mapComic(book);
  checkShape(book, plan);
  const got = levelsOf(book, plan);
  assert.deepEqual(got.map((l) => [l.kind, l.after]), refLevels().map((l) => [l.kind, l.after]));
  assert.equal(got[1].villain, "raptor");
  assert.equal(got[2].villain, "trex");
  assert.equal(got[2].superWeapon, "💣");
  for (const f of ["lion", "truck", "snake"]) assert.ok(got[3].friends.includes(f), f);
  const ch = chaptersOf(book, plan).map((c) => c.title);
  for (const t of ["The Mighty T-Rex", "A new friend", "Time to go home", "Home!"]) assert.ok(ch.includes(t), t);
});

test("robustness: the treehouse sign read off the last panel keeps the climb", () => {
  const book = refBook({ speakers: false });
  book.pages.at(-1).lines.unshift({ who: null, text: "TREE HOUSE" });
  const lv = levelsOf(book, mapComic(book));
  assert.equal(lv.at(-1).kind, "climb");
  assert.equal(lv.at(-1).home, "treehouse");
});

test("a child's own choice in the editor wins over the rules", () => {
  const book = refBook();
  const i = book.pages.findIndex((p) => p.key === "hibirdie");
  book.pages[i].action = "friends"; book.pages[i].actionBy = "child";
  const j = book.pages.findIndex((p) => p.key === "adventure");
  book.pages[j].action = "none"; book.pages[j].actionBy = "child";
  const lv = levelsOf(book, mapComic(book));
  assert.equal(lv[0].kind, "friends");
  assert.equal(lv[0].after, "hibirdie");
  assert.ok(lv[0].chosen);
  assert.ok(!lv.some((l) => l.after === "adventure"));
  // Without actionBy, an action that differs from what the words say counts as the child's.
  const b2 = refBook();
  delete b2.pages[i].actionBy; b2.pages[i].action = "collect";
  assert.equal(levelsOf(b2, mapComic(b2))[0].kind, "collect");
});

// Small original stories, typed and built with buildBook.
const plain = (book, plan) => plan.map((s) => s.type === "story" ? `p${s.page + 1}` : s.type === "chapter" ? `#${s.title}` : `${s.kind}${s.villain ? "(" + book.cast.find((c) => c.id === s.villain).name + ")" : ""}`);

test("story: a princess and a dragon", () => {
  const book = buildBook(`Princess Lily lived in a castle with her horse Star.
Lily: Let's go on an adventure, Star!

They rode into the dark forest. A big dragon flew down. ROAR!

Star: Oh no! What do we do?
Lily: We must fight it with my magic wand!

The dragon flew away.
Lily: Hooray! We won!

Lily: Time to ride home, Star.

They were back at the castle. Everyone had a big party.`, { title: "Lily" });
  const plan = mapComic(book);
  checkShape(book, plan);
  assert.deepEqual(plain(book, plan), ["#The castle", "p1", "journey", "#In the forest", "p2", "p3", "battle(Dragon)", "p4", "#Time to go home", "p5", "journey", "#Home!", "p6"]);
  const lv = plan.filter((s) => s.type === "level");
  assert.deepEqual([lv[0].from, lv[0].to], ["castle", "forest"]);
  assert.equal(lv[1].weapon, "✨");
  assert.equal(lv[1].big, true);
  assert.equal(lv[1].title, "Level 2 · The Mighty Dragon");
  assert.equal(lv[2].to, "home");
  assert.equal(lv[2].title, "Level 3 · Run Home");
});

test("story: a robot makes friends", () => {
  const book = buildBook(`Bolt the robot lived in the city.

Bolt: I want to see the park. Let's go!

At the park Bolt met a puppy named Max.
Max: Woof! Will you be my friend?

Kitty: Meow! Can I play too?

Bolt: Yes! Let's play together!

Bolt and his new friends walked home.

Home at last! Bolt was so happy.`, { title: "Bolt" });
  const plan = mapComic(book);
  checkShape(book, plan);
  const id = (n) => book.cast.find((c) => c.name === n).id;
  assert.deepEqual(plain(book, plan), ["#In the city", "p1", "p2", "journey", "#New friends", "p3", "p4", "p5", "friends", "#Time to go home", "p6", "journey", "#Home!", "p7"]);
  const lv = plan.filter((s) => s.type === "level");
  assert.deepEqual([lv[0].from, lv[0].to], ["city", "park"]);
  assert.deepEqual(lv[1].friends, [id("Max"), id("Kitty")]);
  assert.equal(lv[2].to, "home");
});

test("story: an under-the-sea adventure (no pirates)", () => {
  const book = buildBook(`Finn the fish lived near the beach.

Finn: Let's go exploring!

Deep in the ocean, Finn found shiny gold coins.
Finn: Treasure! Let's collect it!

Oh no! A big shark!
Shark: CHOMP!

Octopus: Let's blast it with water!

The shark swam away.
Finn: Hooray!

Finn: Let's swim back home.

Finn was home, safe and sound.`, { title: "Finn" });
  const plan = mapComic(book);
  checkShape(book, plan);
  assert.deepEqual(plain(book, plan), ["#At the beach", "p1", "p2", "journey", "#Under the sea", "p3", "collect", "p4", "p5", "battle(Shark)", "p6", "#Time to go home", "p7", "journey", "#Home!", "p8"]);
  const lv = plan.filter((s) => s.type === "level");
  assert.deepEqual([lv[0].from, lv[0].to], ["beach", "ocean"]);
  assert.equal(lv[2].weapon, "💧");
  assert.equal(lv[3].from, "ocean");
});

test("story: the built-in example (Pip and Owl)", async () => {
  const { EXAMPLE_STORY } = await import("../js/story.js");
  const book = buildBook(EXAMPLE_STORY);
  const plan = mapComic(book);
  checkShape(book, plan);
  assert.deepEqual(plain(book, plan), ["#At home", "p1", "#In the forest", "p2", "journey", "#The cave", "p3", "collect", "p4", "battle(Dragon)", "climb", "#Home!", "p5"]);
});

/* ---------------- normalizePlan: a plan proposed from outside (e.g. Claude reading the comic) ---------------- */

test("normalizePlan: a good proposal passes through in the game's shape", () => {
  const book = refBook();
  const plan = mapComic(book);
  const out = normalizePlan(book, plan);
  checkShape(book, out);
  assert.deepEqual(levelsOf(book, out).map((l) => [l.kind, l.after, l.title]), levelsOf(book, plan).map((l) => [l.kind, l.after, l.title]));
  assert.deepEqual(chaptersOf(book, out), chaptersOf(book, plan));
});

test("normalizePlan: repairs a messy proposal", () => {
  const book = refBook();
  const proposed = [
    { type: "chapter", title: "  At home  " },
    { type: "story", page: 0 }, { type: "story", page: 0 }, // duplicate
    { type: "story", page: 2 }, // page 1 missing → put back in order
    { type: "level", kind: "run", page: 3, from: "forest", to: "cave", title: "Forest Run" }, // "run" alias
    { type: "level", kind: "battle", page: 7, villain: "Velociraptor", weapon: "arrows" }, // name, word
    { type: "level", kind: "battle", page: 13, villain: "trex", weapons: ["arrows", "bombs"] },
    { type: "level", kind: "parade", page: 20, friends: ["lion", "Fire truck", "nobody", "snake"] },
    { type: "level", kind: "teleport", page: 5 }, // unknown kind → dropped
    { type: "level", kind: "celebrate", page: 21 }, // generic fireworks → dropped
    { type: "chapter", title: "" }, // empty → dropped
    { type: "level", kind: "climb", page: 99 }, // bad page → clamped to the last panel
    { type: "story", page: 999 }, { type: "story", page: "x" },
    "junk", null,
  ];
  const out = normalizePlan(book, proposed);
  checkShape(book, out);
  const lv = levelsOf(book, out);
  assert.deepEqual(lv.map((l) => l.kind), ["journey", "battle", "battle", "friends", "climb"]);
  assert.equal(lv[1].villain, "raptor");
  assert.equal(lv[1].weapon, "🏹");
  assert.equal(lv[2].superWeapon, "💣");
  assert.equal(lv[2].big, true);
  assert.deepEqual(lv[3].friends, ["lion", "truck", "snake"]);
  assert.equal(out[0].type, "chapter");
  assert.equal(out[0].title, "At home");
  assert.equal(lv[0].title, "Level 1 · Forest Run");
});

test("normalizePlan: nothing usable → the rule-based mapping", () => {
  const book = refBook();
  for (const bad of [null, undefined, "nope", [], [{ type: "level", kind: "zzz" }], { steps: 3 }]) {
    assert.deepEqual(normalizePlan(book, bad), mapComic(book));
  }
  assert.deepEqual(normalizePlan({ pages: [] }, [{ type: "story", page: 0 }]), []);
  // planGame takes a stored proposal (book.plan) through normalizePlan.
  const withPlan = { ...book, plan: mapComic(book) };
  assert.deepEqual(planGame(withPlan), normalizePlan(book, withPlan.plan));
});
