import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPages, parseChunk, buildBook, planGame, EXAMPLE_STORY, MAX_PAGES, MAX_CAST, MAX_LEVELS, newId, detectPlace, detectAction } from "../js/story.js";
import { PLACE_KEYS, ACTION_KEYS } from "../js/catalog.js";

const MOUSIE = `Mousie: Hi Daddy! Can I go on an adventure?
Daddy: Yes, but be careful!

Mousie and Birdie walked into the jungle.
Birdie: Look, a Velociraptor!

Mousie: Let's fight it with bombs and arrows!
The velociraptor died.

They climb up the ladder to the treehouse.
Mousie: Hooray! We won!`;

const byName = (book, name) => book.cast.find((c) => c.name === name);
const levels = (plan) => plan.filter((s) => s.type === "level");

function checkBookShape(book) {
  const ids = new Set(book.cast.map((c) => c.id));
  assert.equal(book.kind, "book");
  assert.ok(book.cast.length >= 1 && book.cast.length <= MAX_CAST);
  assert.equal(book.cast.filter((c) => c.role === "hero").length, 1, "exactly one hero");
  for (const c of book.cast) {
    assert.ok(["hero", "friend", "villain"].includes(c.role));
    assert.equal(typeof c.emoji, "string");
    assert.equal(typeof c.name, "string");
  }
  for (const p of book.pages) {
    assert.ok(PLACE_KEYS.includes(p.place), p.place);
    assert.ok(p.action === "none" || ACTION_KEYS.includes(p.action), p.action);
    assert.ok(p.actors.length >= 1);
    for (const a of p.actors) assert.ok(ids.has(a), "actor is in cast");
    for (const l of p.lines) assert.ok(ids.has(l.who), "speaker is in cast");
  }
}

test("newId is 24 hex chars and unique", () => {
  const a = newId(), b = newId();
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, b);
});

test("splitPages: blank lines, line pairs, sentence pairs, Page N markers", () => {
  assert.deepEqual(splitPages(""), []);
  assert.deepEqual(splitPages(null), []);
  assert.deepEqual(splitPages("A cat.\n\nA dog.\r\n\r\nA fox."), ["A cat.", "A dog.", "A fox."]);
  assert.deepEqual(splitPages("one\ntwo\nthree"), ["one\ntwo", "three"]);
  assert.deepEqual(splitPages("One. Two! Three? Four."), ["One. Two!", "Three? Four."]);
  assert.deepEqual(splitPages("Page 1\nThe cat woke.\nPage 2\nThe cat ate."), ["The cat woke.", "The cat ate."]);
});

test("parseChunk: colon dialogue", () => {
  const r = parseChunk("Pip went out.\nPip: I want to go!\nOwl: \"Me too\"");
  assert.equal(r.narration, "Pip went out.");
  assert.deepEqual(r.lines, [{ name: "Pip", text: "I want to go!" }, { name: "Owl", text: "Me too" }]);
});

test("parseChunk: \"...\" said X and X said \"...\" with curly quotes", () => {
  // Curly quotes are straightened by splitPages (as buildBook does) before parseChunk.
  const [chunk] = splitPages("\u201cHello there,\u201d said Tom. Then Ann asked, \u201cWho are you?\u201d");
  const r = parseChunk(chunk);
  assert.deepEqual(r.lines.slice(0, 2), [{ name: "Tom", text: "Hello there," }, { name: "Ann", text: "Who are you?" }]);
  const r2 = parseChunk("\"Run!\" shouted the dragon.");
  assert.deepEqual(r2.lines, [{ name: "Dragon", text: "Run!" }]);
});

test("parseChunk: lone quotes have no speaker", () => {
  const r = parseChunk("She laughed. \"Oh wow!\"");
  assert.deepEqual(r.lines, [{ name: null, text: "Oh wow!" }]);
  assert.equal(r.narration, "She laughed.");
});

test("buildBook on EXAMPLE_STORY: cast, places, actions", () => {
  const b = buildBook(EXAMPLE_STORY, { title: "  Pip's Big Day ", author: " Sam " });
  checkBookShape(b);
  assert.equal(b.title, "Pip's Big Day");
  assert.equal(b.author, "Sam");
  assert.equal(b.pages.length, 5);
  assert.equal(byName(b, "Pip")?.role, "hero");
  assert.equal(byName(b, "Owl")?.kind, "owl");
  assert.equal(byName(b, "Owl")?.role, "friend");
  const dragon = b.cast.find((c) => c.kind === "dragon");
  assert.ok(dragon, "dragon is in the cast");
  assert.equal(dragon.role, "villain");
  assert.equal(dragon.big, true);
  const places = b.pages.map((p) => p.place);
  for (const p of ["home", "forest", "cave"]) assert.ok(places.includes(p), p);
  const actions = b.pages.map((p) => p.action);
  for (const a of ["journey", "collect", "battle", "climb"]) assert.ok(actions.includes(a), a);
  assert.ok(b.pages[3].actors.includes(dragon.id), "dragon appears on the battle page");
  assert.equal(b.pages[0].lines[0].who, byName(b, "Pip").id);
});

test("buildBook defaults", () => {
  const b = buildBook("The cat sat.");
  checkBookShape(b);
  assert.equal(b.title, "My Story");
  assert.equal(b.cast[0].kind, "cat");
  assert.equal(b.stars, 0);
  assert.equal(b.plays, 0);
  const empty = buildBook("");
  assert.equal(empty.pages.length, 0);
  assert.equal(empty.cast.length, 1);
  assert.equal(empty.cast[0].role, "hero");
});

test("Mousie-style story: dad dedupe, battle and villain detection", () => {
  const b = buildBook(MOUSIE, { title: "Mousie" });
  checkBookShape(b);
  const mousie = byName(b, "Mousie");
  assert.equal(mousie?.kind, "mouse");
  assert.equal(mousie.role, "hero");
  assert.equal(byName(b, "Daddy")?.kind, "dad");
  assert.equal(b.cast.filter((c) => c.kind === "dad").length, 1, "Daddy is one character");
  assert.equal(byName(b, "Birdie")?.kind, "bird");
  const raptor = b.cast.find((c) => c.kind === "raptor");
  assert.ok(raptor, "velociraptor detected");
  assert.equal(raptor.role, "villain");
  const battle = b.pages.find((p) => p.action === "battle");
  assert.ok(battle, "battle page detected");
  assert.ok(battle.actors.includes(raptor.id));
  assert.ok(b.pages.some((p) => p.action === "climb"));
  assert.equal(b.pages[0].action, "journey");
  assert.equal(b.pages[0].place, "forest");
  const plan = planGame(b);
  const kinds = levels(plan).map((s) => s.kind);
  assert.ok(kinds.includes("battle"));
  assert.ok(kinds.includes("climb"));
  assert.equal(kinds.at(-1), "celebrate");
});

test("a battle with no villain gets a Monster", () => {
  const b = buildBook("Sam: Let's fight!\n\nSam: We did it.");
  const m = b.cast.find((c) => c.kind === "monster");
  assert.ok(m);
  assert.equal(m.role, "villain");
  assert.ok(b.pages[0].actors.includes(m.id));
});

test("planGame: always at least 2 levels, ends with celebrate, steps are valid", () => {
  // An empty story has nothing to play.
  assert.deepEqual(planGame(buildBook("")), []);
  const stories = [EXAMPLE_STORY, MOUSIE, "The cat sat.", "A.\n\nB.\n\nC.", "We fight.\n\nHooray!"];
  for (const s of stories) {
    const b = buildBook(s);
    const plan = planGame(b);
    const lv = levels(plan);
    assert.ok(lv.length >= 2, `≥2 levels for ${JSON.stringify(s)}`);
    assert.equal(plan.at(-1).type, "level");
    assert.equal(plan.at(-1).kind, "celebrate");
    for (const st of plan) {
      assert.ok(["story", "level"].includes(st.type));
      assert.ok(Number.isInteger(st.page) && st.page >= 0);
      if (b.pages.length) assert.ok(st.page < b.pages.length);
      if (st.type === "level") assert.ok(ACTION_KEYS.includes(st.kind), st.kind);
    }
    assert.equal(plan.filter((x) => x.type === "story").length, b.pages.length, "every page is a story step");
  }
});

test("planGame: no back-to-back repeats of the same level kind", () => {
  const b = buildBook(Array.from({ length: 6 }, (_, i) => `They fight the dragon ${i}.`).join("\n\n"));
  const kinds = levels(planGame(b)).map((s) => s.kind);
  assert.ok(kinds.filter((k) => k === "battle").length <= 2, kinds.join());
});

test("MAX limits: pages, cast, levels", () => {
  const many = Array.from({ length: MAX_PAGES + 25 }, (_, i) => `Page text ${i}.`).join("\n\n");
  assert.equal(splitPages(many).length, MAX_PAGES);
  assert.equal(buildBook(many).pages.length, MAX_PAGES);

  const names = ["Ann", "Ben", "Cal", "Dot", "Eve", "Fay", "Gus", "Hal", "Ida", "Jon", "Kit", "Lou"];
  const b = buildBook(names.map((n) => `${n}: Hello!`).join("\n\n"));
  assert.equal(b.cast.length, MAX_CAST);
  checkBookShape(b);

  const kinds = ["fight", "treasure", "climb", "walk", "friends", "fight", "treasure", "climb", "walk", "friends", "fight", "treasure"];
  const busy = buildBook(kinds.map((k, i) => `Line ${i}: we ${k}.`).join("\n\n"));
  const lv = levels(planGame(busy));
  assert.ok(lv.length <= MAX_LEVELS + 1, `levels ${lv.length}`); // + the final celebration
  assert.equal(lv.at(-1).kind, "celebrate");
});

test("detectPlace / detectAction", () => {
  assert.equal(detectPlace("They flew to the moon and saw a planet"), "space");
  assert.equal(detectPlace("nothing here", "beach"), "beach");
  assert.equal(detectAction("We found gold coins"), "collect");
  assert.equal(detectAction("hello"), null);
});

test("\"Pip the bunny\" links Pip to the bunny character", () => {
  const b = buildBook(EXAMPLE_STORY);
  assert.equal(byName(b, "Pip").kind, "bunny");
  assert.ok(!byName(b, "Bunny"));
});

test("a story whose only action is a celebration still gets 2 levels", () => {
  const lv = levels(planGame(buildBook("Hooray! The end.")));
  assert.ok(lv.length >= 2, lv.map((s) => s.kind).join());
});
