// js/ai.js: strict checks on the comic reader's answer, and building a book from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnalysis, bookFromAnalysis, validEndpoint, aiReady, AiError, DEFAULT_ENDPOINT } from "../js/ai.js";
import { PLACE_KEYS } from "../js/catalog.js";

// An answer in the Worker's shape for 5 panels (numbered from 1 as sent).
function answer() {
  return {
    title: "Hoppy",
    cast: [
      { id: "hoppy", name: "Hoppy", role: "hero", big: false, kind: "bunny", emoji: "🐇", appearances: [{ panel: 2, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.7 }, faces: "right" }] },
      { id: "owl", name: "Owl", role: "friend", big: false, kind: "owl", emoji: "🦉", appearances: [] },
      { id: "dragon", name: "Dragon", role: "villain", big: true, kind: "dragon", emoji: "🐉", appearances: [{ panel: 4, box: { x: 0, y: 0, w: 1, h: 1 }, faces: "left" }] },
    ],
    panels: [
      { index: 1, part: "cover", place: "forest", chapter: "", characters: ["hoppy"], narration: "", lines: [{ speaker: null, text: "HOPPY", kind: "caption" }] },
      { index: 2, part: "story", place: "forest", chapter: "In the forest", characters: ["hoppy", "owl"], narration: "", lines: [{ speaker: "hoppy", text: "Let's go on an adventure!", kind: "speech" }] },
      { index: 3, part: "story", place: "cave", chapter: "The cave", characters: ["hoppy"], narration: "Hoppy tiptoes into the cave.", lines: [] },
      { index: 4, part: "story", place: "cave", chapter: "The Mighty Dragon", characters: ["dragon", "owl"], narration: "", lines: [{ speaker: "dragon", text: "ROAR!", kind: "speech" }, { speaker: "owl", text: "Let's fight it with snowballs and bombs!", kind: "speech" }, { speaker: null, text: "BOOM!", kind: "sfx" }] },
      { index: 5, part: "extra", place: "home", chapter: "", characters: [], narration: "", lines: [] },
    ],
    plan: [
      { type: "chapter", title: "In the forest", panel: 2 },
      { type: "story", panel: 2 },
      { type: "level", kind: "journey", panel: 2, from: "forest", to: "cave", name: "Forest Run", title: "Level 1 · Forest Run" },
      { type: "chapter", title: "The cave", panel: 3 },
      { type: "story", panel: 3 },
      { type: "chapter", title: "The Mighty Dragon", panel: 4 },
      { type: "story", panel: 4 },
      { type: "level", kind: "battle", panel: 4, villain: "dragon", weapon: "❄️", superWeapon: "💣", big: true, name: "The Mighty Dragon", title: "Level 2 · The Mighty Dragon" },
    ],
    model: "claude-opus-5-5",
    usage: { input_tokens: 10, output_tokens: 20, fallback: false },
  };
}

test("validateAnalysis: a good answer comes back clean, numbered from 0", () => {
  const a = validateAnalysis(answer(), 5);
  assert.equal(a.title, "Hoppy");
  assert.deepEqual(a.panels.map((p) => p.index), [0, 1, 2, 3, 4]);
  assert.equal(a.cast[0].appearances[0].panel, 1);
  assert.deepEqual(a.plan[0], { type: "chapter", title: "In the forest", panel: 1 });
  assert.equal(a.plan.at(-1).villain, "dragon");
  assert.equal(a.plan.at(-1).panel, 3);
});

test("validateAnalysis: anything wrong is refused", () => {
  const cases = {
    "not an object": () => "nope",
    "wrong panel count": (a) => { a.panels.pop(); },
    "panels out of order": (a) => { [a.panels[1], a.panels[2]] = [a.panels[2], a.panels[1]]; },
    "unknown place": (a) => { a.panels[1].place = "volcano"; },
    "speaker not in cast": (a) => { a.panels[1].lines[0].speaker = "nobody"; },
    "empty line": (a) => { a.panels[1].lines[0].text = "  "; },
    "line too long": (a) => { a.panels[1].lines[0].text = "x".repeat(401); },
    "unknown line kind": (a) => { a.panels[1].lines[0].kind = "shout"; },
    "box outside the panel": (a) => { a.cast[0].appearances[0].box.x = 0.9; },
    "negative box": (a) => { a.cast[0].appearances[0].box.w = -0.1; },
    "box NaN": (a) => { a.cast[0].appearances[0].box.y = NaN; },
    "appearance in a panel that doesn't exist": (a) => { a.cast[0].appearances[0].panel = 9; },
    "panel 0": (a) => { a.cast[0].appearances[0].panel = 0; },
    "bad cast id": (a) => { a.cast[0].id = "Hoppy <b>"; },
    "duplicate cast id": (a) => { a.cast[1].id = "hoppy"; },
    "too many characters": (a) => { for (let i = 0; i < 6; i++) a.cast.push({ ...a.cast[1], id: "x" + i }); },
    "unknown kind": (a) => { a.cast[0].kind = "unicorncat"; },
    "not an emoji": (a) => { a.cast[0].emoji = "bunny"; },
    "bad role": (a) => { a.cast[0].role = "boss"; },
    "extra key": (a) => { a.cast[0].evil = true; },
    "fireworks level": (a) => { a.plan.push({ type: "level", kind: "celebrate", panel: 4, name: "Party", title: "Level 3 · Party" }); },
    "unknown step": (a) => { a.plan.push({ type: "cutscene", panel: 2 }); },
    "villain who is a friend": (a) => { a.plan.at(-1).villain = "owl"; },
    "unknown weapon": (a) => { a.plan.at(-1).weapon = "🔫"; },
    "weapon on a run": (a) => { a.plan[2].weapon = "🏹"; },
    "friend not in cast": (a) => { a.plan.push({ type: "level", kind: "friends", panel: 4, friends: ["ghost"], name: "Play", title: "Level 3 · Play" }); },
    "level in a missing panel": (a) => { a.plan[2].panel = 6; },
    "unknown place on a level": (a) => { a.plan[2].to = "mars"; },
    "no story steps": (a) => { a.plan = a.plan.filter((s) => s.type !== "story"); },
    "title too long": (a) => { a.title = "x".repeat(81); },
  };
  for (const [name, spoil] of Object.entries(cases)) {
    const a = answer();
    const out = spoil(a);
    assert.throws(() => validateAnalysis(out === undefined ? a : out, 5), (e) => e instanceof AiError && e.code === "bad_response", name);
  }
});

test("bookFromAnalysis: story panels become pages, the cover the cover, extras are left out", () => {
  const a = validateAnalysis(answer(), 5);
  const images = ["img-cover", "img-1", "img-2", "img-3", "img-extra"];
  const { book, appearances } = bookFromAnalysis(a, { panelImage: (i) => images[i], profile: { id: "kid", name: "Sam", avatar: "🦊" } });
  assert.equal(book.kind, "book");
  assert.equal(book.profileId, "kid");
  assert.equal(book.title, "Hoppy");
  assert.equal(book.cover, "img-cover");
  assert.deepEqual(book.pages.map((p) => p.imageId), ["img-1", "img-2", "img-3"]);
  for (const p of book.pages) {
    assert.ok(PLACE_KEYS.includes(p.place));
    assert.equal(p.action, "none");
    assert.equal(p.actionBy, "auto");
  }
  // The cast gets new ids, and every reference follows.
  const ids = new Map(book.cast.map((c) => [c.name, c.id]));
  assert.equal(book.cast.length, 3);
  assert.ok(book.cast.every((c) => /^[0-9a-f]{24}$/.test(c.id)));
  assert.equal(book.cast.find((c) => c.role === "hero").name, "Hoppy");
  assert.equal(book.cast[0].faces, "right");
  assert.ok(book.cast[0].words.includes("hoppy") && book.cast[0].words.includes("bunny"));
  assert.deepEqual(book.pages[0].lines, [{ who: ids.get("Hoppy"), text: "Let's go on an adventure!" }]);
  assert.deepEqual(book.pages[2].lines.at(-1), { who: null, text: "BOOM!", kind: "sfx" });
  assert.equal(book.pages[1].narration, "Hoppy tiptoes into the cave.");
  assert.deepEqual(book.pages[2].actors.sort(), [ids.get("Dragon"), ids.get("Owl")].sort());
  // The plan points at pages (0-based) and real cast ids, ready for normalizePlan.
  assert.deepEqual(book.plan.map((s) => [s.type, s.page]), [["chapter", 0], ["story", 0], ["level", 0], ["chapter", 1], ["story", 1], ["chapter", 2], ["story", 2], ["level", 2]]);
  const battle = book.plan.at(-1);
  assert.equal(battle.villain, ids.get("Dragon"));
  assert.equal(battle.villainName, "Dragon");
  assert.equal(battle.villainKey, "dragon");
  assert.equal(battle.villainEmoji, "🐉");
  assert.equal(battle.superWeapon, "💣");
  assert.ok(!("panel" in battle));
  // Where to cut each character out: positions in the panels sent.
  assert.deepEqual(appearances.get(ids.get("Hoppy")), [{ panel: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.7 }, faces: "right" }]);
  assert.deepEqual(appearances.get(ids.get("Owl")), []);
});

test("bookFromAnalysis: no cast → the child is the hero", () => {
  const a = validateAnalysis({ ...answer(), cast: [], panels: answer().panels.map((p) => ({ ...p, characters: [], lines: p.lines.map((l) => ({ ...l, speaker: null })) })), plan: [{ type: "story", panel: 2 }] }, 5);
  const { book } = bookFromAnalysis(a, { panelImage: () => null, profile: { id: "kid", name: "Sam", avatar: "🦊" } });
  assert.equal(book.cast.length, 1);
  assert.equal(book.cast[0].name, "Sam");
  assert.equal(book.cast[0].role, "hero");
});

test("validEndpoint: https only (http on localhost), no credentials or query", () => {
  assert.equal(validEndpoint(DEFAULT_ENDPOINT), DEFAULT_ENDPOINT);
  assert.equal(validEndpoint(DEFAULT_ENDPOINT + "/"), DEFAULT_ENDPOINT);
  assert.equal(validEndpoint("http://localhost:8787"), "http://localhost:8787");
  for (const bad of ["http://api.rawrbooks.com", "https://user:pw@api.rawrbooks.com", "https://api.rawrbooks.com/?x=1", "javascript:alert(1)", "", null, "ftp://x"]) assert.equal(validEndpoint(bad), null, String(bad));
});

test("aiReady: needs on + consent + a family code + a good address", () => {
  const ok = { enabled: true, consentAt: 1, familyCode: "abc", endpoint: DEFAULT_ENDPOINT };
  assert.equal(aiReady(ok), true);
  assert.equal(aiReady({ ...ok, enabled: false }), false);
  assert.equal(aiReady({ ...ok, consentAt: null }), false);
  assert.equal(aiReady({ ...ok, familyCode: "" }), false);
  assert.equal(aiReady({ ...ok, endpoint: "http://evil.example" }), false);
});
