// "Add my finished book": a child brings in a book they already made (a PDF of their comic,
// photos or scans of the pages, or a typed story) and it becomes a game, fully automatically:
// pick the files → one friendly progress screen → straight into the game. The comic reader and
// the editor stay available from the shelf afterwards.
//
// With Claude AI turned on in Grown-ups (js/ai.js), the comic's panels are read by Claude, which
// transcribes the words, finds the characters (cut out of the drawings for the game) and plans
// the levels. Without it, or if it can't help (offline, busy, quota), the book is still made on
// the device with the rule-based plan and emoji characters.
import { h, show, button, topbar, pickFile } from "../ui.js";
import * as store from "../store.js";
import { buildBook, parseChunk, detectPlace, detectAction, MAX_PAGES, newId } from "../story.js";
import { countWords } from "../catalog.js";
import { pagePhoto } from "../images.js";
import { ACCEPT, readBookFiles, splitIntoPanels } from "../importbook.js";
import { aiSettings, aiReady, analyzeComic, bookFromAnalysis, MAX_PANELS } from "../ai.js";
import { autoCutCast } from "../cutout.js";
import { nav, screen } from "./common.js";
import { playBook } from "./shelf.js";

// File-picker filters for each choice, taken from the importer's ACCEPT list.
const ACCEPT_PARTS = String(ACCEPT || "").split(",").map((s) => s.trim()).filter(Boolean);
const acceptOf = (re, dflt) => { const p = ACCEPT_PARTS.filter((x) => re.test(x)); return p.length ? p.join(",") : dflt; };
const ACCEPT_PDF = acceptOf(/pdf/i, "application/pdf,.pdf");
const ACCEPT_IMG = acceptOf(/^image\/|^\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i, "image/*,.heic,.heif");
const ACCEPT_TXT = acceptOf(/^text\/|^\.txt$/i, "text/plain,.txt");

const NOTICE_MS = 3500; // how long a "Claude couldn't help" note stays before the game starts
const AI_TIP = "Tip for grown-ups: turn on “Build games with Claude AI” in Grown-ups for a much better game, with the comic's own words and characters.";

// Only one import runs at a time. Locking (or leaving) stops it and drops its pictures.
let active = null;
let lockHooked = false;

export function finishedBook(profileId) {
  const profile = store.isUnlocked() ? store.get(profileId) : null;
  if (!profile) return nav.picker();
  dispose(active);
  if (!lockHooked) { lockHooked = true; store.onLock(() => dispose(active)); }
  const st = { profile, alive: true, run: 0, step: "choose", abort: null, created: [], draft: store.beginDraft() };
  active = st;
  st.offDrop = hookDrop(st);
  chooseStep(st);
}

function dispose(st) {
  if (!st) return;
  st.alive = false;
  st.run++;
  st.abort?.abort();
  st.offDrop?.();
  store.endDraft(st.draft);
  if (active === st) active = null;
}

function leave(st) {
  const id = st.profile.id;
  dispose(st);
  nav.shelf(id);
}

// Desktop drag-and-drop: files dropped anywhere on the first screen are used.
// While this screen is open, a stray drop never makes the browser leave the app.
function hookDrop(st) {
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const over = (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = st.step === "choose" ? "copy" : "none";
    if (st.step === "choose") document.body.classList.add("fb-dragging");
  };
  const out = (e) => { if (!e.relatedTarget) document.body.classList.remove("fb-dragging"); };
  const drop = (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove("fb-dragging");
    const files = [...(e.dataTransfer.files || [])];
    if (st.alive && st.step === "choose" && files.length) make(st, files);
  };
  document.addEventListener("dragover", over);
  document.addEventListener("dragleave", out);
  document.addEventListener("drop", drop);
  return () => {
    document.removeEventListener("dragover", over);
    document.removeEventListener("dragleave", out);
    document.removeEventListener("drop", drop);
    document.body.classList.remove("fb-dragging");
  };
}

// ---------- what did you make? ----------
function chooseStep(st, error = "") {
  st.step = "choose";
  const choice = (icon, label, sub, accept, multiple) => h("button", {
    type: "button", class: "fb-choice",
    onclick: async () => {
      const files = await pickFile(accept, multiple);
      if (files.length && st.alive && st.step === "choose") make(st, files);
    },
  },
  h("span", { class: "fb-choice-ico", "aria-hidden": "true" }, icon),
  h("span", { class: "fb-choice-text" }, h("strong", null, label), h("span", null, sub)));

  const ai = aiReady();
  show(
    topbar({ title: "Add my finished book", back: () => leave(st) }),
    screen("narrow fb",
      h("div", { class: "fb-hello" },
        h("span", { class: "big-emoji", "aria-hidden": "true" }, "📚"),
        h("h2", null, "Do you already have a finished book?"),
        h("p", null, "Bring it in! We'll turn it into your game, all by ourselves.")),
      error ? h("p", { class: "fb-error", role: "alert" }, "😕 ", error) : null,
      h("div", { class: "fb-choices", role: "group", "aria-label": "What kind of book?" },
        choice("📄", "A PDF of my comic", "A printed or scanned comic, saved as a PDF", ACCEPT_PDF, false),
        choice("🖼️", "Photos or scans of my pages", "Pick all your pages at once. They stay in order.", ACCEPT_IMG, true),
        choice("📝", "My story as a text file", "A story you typed, saved as .txt", ACCEPT_TXT, false)),
      h("div", { class: "fb-drop", "aria-hidden": "true" }, "⬇️ Or drop your files here"),
      h("p", { class: "small muted center-text fb-safe" }, ai
        ? "✨ Claude AI is on: your comic's pages are sent to Claude to read the words and plan the game. Nothing else is sent."
        : "🔒 Your book stays on this device.")));
}

// ---------- the one progress screen ----------
const STAGES = [
  ["read", "📖", "Reading your comic…"],
  ["cast", "🔎", "Finding your characters…"],
  ["build", "🎮", "Building your game…"],
];
function workScreen(st, { ai, onCancel }) {
  const fill = h("div", { class: "fb-bar-fill" });
  const bar = h("div", { class: "fb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const label = h("p", { class: "fb-bar-label", "aria-live": "polite" }, "Getting ready…");
  const rows = new Map(STAGES.map(([key, icon, text]) => [key, h("li", { class: "aiw-stage" },
    h("span", { class: "aiw-ico", "aria-hidden": "true" }, icon), h("span", { class: "aiw-text" }, text), h("span", { class: "aiw-tick", "aria-hidden": "true" }))]));
  const note = h("div", { class: "aiw-note", role: "status", hidden: true });
  const tip = ai ? null : h("p", { class: "aiw-tip small" }, "💡 ", AI_TIP);
  const cancel = button("✋ Cancel", onCancel, "big ghost");
  show(
    topbar({ title: "Making your game", back: onCancel }),
    screen("narrow fb center",
      h("div", { class: "card stack fb-busy aiw" },
        h("span", { class: "big-emoji fb-bounce", "aria-hidden": "true" }, "✨"),
        h("h2", null, "Making your game!"),
        h("ol", { class: "aiw-stages" }, [...rows.values()]),
        h("div", { class: "fb-progress" }, label, bar),
        note,
        h("div", { class: "row center" }, cancel),
        tip)));
  let current = null;
  return {
    stage(key) {
      current = key;
      let seen = false;
      for (const [k, li] of rows) {
        const now = k === key;
        li.classList.toggle("active", now);
        li.classList.toggle("done", !seen && !now);
        if (now) { seen = true; li.setAttribute("aria-current", "step"); } else li.removeAttribute("aria-current");
      }
      const s = STAGES.find(([k]) => k === key);
      if (s) label.textContent = s[2];
    },
    set(done, total, text) {
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
      fill.style.width = pct + "%";
      bar.setAttribute("aria-valuenow", String(pct));
      if (text) label.textContent = text;
    },
    note(text) { note.replaceChildren(h("span", { "aria-hidden": "true" }, "💡 "), text); note.hidden = false; },
    // The book is saved: Cancel becomes "Play now" (for the moment a note is shown).
    ready(onPlay) { cancel.replaceWith(button("▶ Play now", onPlay, "big go")); },
    get stageKey() { return current; },
  };
}

// ---------- the whole automatic flow ----------
async function make(st, files) {
  const run = ++st.run;
  st.step = "working";
  const ctl = new AbortController();
  st.abort = ctl;
  const stale = () => !st.alive || st.run !== run;
  let cancelled = false;
  const created = [];
  const cancel = async () => {
    if (cancelled || stale()) return;
    cancelled = true;
    st.run++;
    ctl.abort();
    await dropImages(created);
    if (st.alive) chooseStep(st);
  };
  const ai = aiReady() ? aiSettings() : null;
  const ui = workScreen(st, { ai: !!ai, onCancel: cancel });
  const failAt = async (msg) => {
    await dropImages(created);
    if (!stale()) chooseStep(st, msg);
  };

  try {
    // 1. Read the files.
    ui.stage("read");
    const res = await readBookFiles(files, {
      onProgress: ({ done = 0, total = 0, label = "" } = {}) => {
        if (stale()) return;
        const n = Math.min(total, done + 1);
        const text = label && label !== "Done" ? label.replace(/[.…\s]*$/, "…") : "";
        ui.set(done, total * 2, text || (total ? `Opening page ${n} of ${total}…` : "Opening your book…"));
      },
    });
    if (stale()) return;
    const pages = (res?.pages || []).filter((p) => p && p.blob instanceof Blob);
    const storyText = typeof res?.storyText === "string" ? res.storyText : "";
    const fileTitle = String(res?.title || "").trim().slice(0, 80);

    if (!pages.length) {
      if (!storyText.trim()) return failAt((res?.warnings || [])[0] || "We couldn't find any pages in that. Try another file?");
      ui.stage("build");
      const book = buildBook(storyText, { title: fileTitle || "My Story", author: st.profile.name });
      if (!book.pages.length) return failAt("That story file looks empty. Try another one?");
      childHero(book.cast, st.profile);
      return finishBook(st, run, { ...book, profileId: st.profile.id }, created, ui, null);
    }

    // 2. Cut the pages into panels (the first page is the cover and stays whole).
    const items = [];
    const limit = ai ? MAX_PANELS : MAX_PAGES;
    for (let i = 0; i < pages.length && items.length < limit; i++) {
      ui.set(pages.length + i, pages.length * 2, `Finding the panels on page ${i + 1}…`);
      const p = pages[i];
      let parts = [];
      if (i > 0 && pages.length > 1) { try { parts = await splitIntoPanels(p.blob); } catch { parts = []; } }
      if (stale()) return;
      parts = (parts || []).filter((c) => c && c.blob instanceof Blob);
      const text = typeof p.text === "string" ? p.text : "";
      if (parts.length > 1) parts.forEach((c, j) => items.push({ blob: c.blob, text: j === 0 ? text : "" }));
      else items.push({ blob: p.blob, text });
    }
    items.splice(limit);

    // 3. Claude reads the comic (when it's turned on).
    let reading = null, why = null;
    if (ai) {
      ui.set(0, 1, "Sending your comic to Claude…");
      try {
        reading = await analyzeComic(items.map((it) => it.blob), {
          signal: ctl.signal, settings: ai, titleHint: fileTitle,
          onProgress: (p) => { if (!stale()) aiProgress(ui, p, items.length); },
        });
      } catch (e) {
        if (stale() || e?.code === "cancelled") return;
        why = e;
      }
      if (stale()) return;
    }

    // 4. Store the pictures, cut out the characters, and put the book together.
    ui.stage("cast");
    if (reading) {
      const need = new Set(reading.panels.filter((p) => p.part !== "extra").map((p) => p.index));
      const ids = new Map();
      let n = 0;
      for (const i of need) {
        ui.set(n++, need.size * 2, "Putting your pictures in…");
        const { bytes, mime } = await storable(items[i].blob);
        if (stale()) return dropImages(created);
        const id = await store.putImage(bytes, mime);
        created.push(id);
        ids.set(i, id);
      }
      const title = reading.title && !/^my comic$/i.test(reading.title) ? reading.title : fileTitle || reading.title;
      const { book, appearances } = bookFromAnalysis(reading, { panelImage: (i) => ids.get(i) || null, profile: st.profile, title });
      book.profileId = st.profile.id;
      let k = 0;
      for (const c of book.cast) {
        ui.set(need.size + k++, need.size + book.cast.length, `Finding ${c.name}…`);
        const looks = (appearances.get(c.id) || []).filter((a) => items[a.panel]);
        if (!looks.length) continue;
        let cut = null;
        try { cut = await autoCutCast(looks.map((a) => ({ blob: items[a.panel].blob, rect: a.rect, panelIndex: a.panel }))); } catch { cut = null; }
        if (stale()) return dropImages(created);
        if (!cut) continue;
        const id = await store.putImage(cut.bytes, cut.mime || "image/png");
        created.push(id);
        c.imageId = id;
        const used = looks.find((a) => a.panel === cut.panelIndex);
        if (used) c.faces = used.faces;
      }
      return finishBook(st, run, book, created, ui, null);
    }

    // Without Claude: every panel is a page; the game comes from the rule-based plan.
    const pageItems = items.slice(0, MAX_PAGES);
    for (let i = 0; i < pageItems.length; i++) {
      ui.set(i, pageItems.length, "Putting your pictures in…");
      const { bytes, mime } = await storable(pageItems[i].blob);
      if (stale()) return dropImages(created);
      const id = await store.putImage(bytes, mime);
      created.push(id);
      pageItems[i].imageId = id;
    }
    const book = assemble(st.profile, fileTitle, storyText, pageItems);
    return finishBook(st, run, book, created, ui, ai ? noteFor(why) : null);
  } catch (e) {
    if (stale()) { await dropImages(created); return; }
    return failAt(e?.message && e.message !== "locked" ? e.message : "Something went wrong. Please try again.");
  }
}

function aiProgress(ui, p, total) {
  if (p.stage === "preparing") { ui.stage("read"); ui.set(p.done || 0, (p.total || total) * 4, "Getting your comic ready for Claude…"); }
  else if (p.stage === "sending") ui.set(total, total * 4, "Sending your comic to Claude…");
  else if (p.stage === "reading" || p.stage === "thinking") ui.set(total * 2, total * 4, "Claude is reading your comic…");
  else if (p.stage === "writing") {
    const d = Math.max(0, Math.min(total, p.done || 0));
    ui.set(total * 2 + d * 2, total * 4, d ? `Claude is reading panel ${Math.min(d + 1, total)} of ${total}…` : "Claude is reading your comic…");
  }
}

// Why Claude couldn't help, in a gentle line for the grown-up, and what happens instead.
function noteFor(err) {
  const reason = {
    offline: "This device is offline, so",
    rate_limited: "Claude has made lots of games today, so",
    busy: "Claude is very busy right now, so",
    family_code: "The family code in Grown-ups doesn't match, so",
    refused: "Claude couldn't read this comic, so",
    too_big: "This comic is too big for Claude in one go, so",
  }[err?.code] || "Claude couldn't help this time, so";
  return `${reason} we made a simpler game. You can try again later from Grown-ups → Claude AI.`;
}

async function finishBook(st, run, book, created, ui, note) {
  if (!st.alive || st.run !== run) { await dropImages(created); return; }
  ui.stage("build");
  ui.set(1, 2, "Building your game…");
  if (note) ui.note(note);
  let saved;
  try { saved = await store.save(book); } catch (e) {
    await dropImages(created);
    if (st.alive && st.run === run) chooseStep(st, "Your game couldn't be saved. Please try again.");
    return;
  }
  created.length = 0; // they belong to the saved book now
  ui.set(1, 1, "Ready!");
  if (note) await new Promise((r) => { const t = setTimeout(r, NOTICE_MS); ui.ready(() => { clearTimeout(t); r(); }); });
  if (!st.alive || st.run !== run) return; // locked meanwhile: the book is saved and on the shelf
  dispose(st);
  playBook(saved.id);
}

async function dropImages(ids) {
  for (const id of ids.splice(0)) { try { await store.deleteImage(id); } catch { /* locked: the sweep tidies up */ } }
}

// Picture bytes to store. Pictures the importer drew itself (PNG/JPEG) are kept as they are;
// anything else (an original photo file, another format, a huge picture) is redrawn first,
// which also drops hidden location data.
async function storable(blob) {
  const type = (blob.type || "").toLowerCase();
  const drawn = !(blob instanceof File) && (type === "image/jpeg" || type === "image/png") && blob.size <= 6 * 1024 * 1024;
  if (drawn) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: type };
  return pagePhoto(blob);
}

// The book made on the device (no Claude): panel pictures in order, words from the PDF's text
// layer or a typed story when there is one, the child as the hero, and no level choices, so the
// game uses the rule-based plan (story.planGame → mapComic).
function assemble(profile, fileTitle, storyText, items) {
  const title = fileTitle || "My Book";
  const texts = items.map((it) => String(it.text || "").trim());
  const hasText = texts.some(Boolean);

  if (!hasText && storyText.trim()) {
    const book = buildBook(storyText, { title, author: profile.name });
    childHero(book.cast, profile);
    const hero = heroOf(book.cast);
    items.forEach((it, i) => {
      if (book.pages[i]) book.pages[i].imageId = it.imageId;
      else book.pages.push(blank(hero, book.pages[i - 1]?.place, it.imageId));
    });
    book.pages = book.pages.slice(0, MAX_PAGES);
    return { ...book, profileId: profile.id, cover: book.pages[0]?.imageId || null };
  }

  const cast = hasText ? buildBook(texts.filter(Boolean).join("\n\n"), { title }).cast : [];
  childHero(cast, profile);
  const hero = heroOf(cast);
  const lookup = (name) => {
    const n = name.toLowerCase();
    return cast.find((c) => c.name.toLowerCase() === n || (c.words || []).some((w) => w === n || n === w + "s"));
  };
  let place = "forest";
  let last = hero;
  const pages = items.map((it, i) => {
    const t = texts[i];
    if (!t) return blank(hero, place, it.imageId);
    const parsed = parseChunk(t);
    place = detectPlace(t, place);
    const lines = parsed.lines.map((l) => {
      const who = (l.name && lookup(l.name)) || last;
      last = who;
      return { who: who.id, text: l.text };
    });
    const actors = cast.filter((c) => lines.some((l) => l.who === c.id) || countWords(t, [c.name.toLowerCase(), ...(c.words || [])]) > 0).map((c) => c.id);
    return { id: newId(), imageId: it.imageId, place, narration: parsed.narration || "", lines, actors: actors.length ? actors : [hero.id], action: detectAction(t) || "none", actionBy: "auto" };
  });
  return {
    kind: "book", profileId: profile.id, title, author: profile.name,
    cast, pages, stars: 0, plays: 0, cover: pages[0]?.imageId || null,
  };
}

const heroOf = (cast) => cast.find((c) => c.role === "hero") || cast[0];
function blank(hero, place = "forest", imageId = null) {
  return { id: newId(), imageId, place: place || "forest", narration: "", lines: [], actors: hero ? [hero.id] : [], action: "none", actionBy: "auto" };
}

// No characters found (or only the builder's stand-in "Hero"): the child is the hero,
// with their own profile picture.
function childHero(cast, profile) {
  const standIn = cast.length === 1 && cast[0].name === "Hero" && !cast[0].kind;
  const hero = { id: standIn ? cast[0].id : newId(), name: profile.name, emoji: profile.avatar || "🧒", kind: null, faces: "front", flip: false, imageId: null, role: "hero", big: false, words: [] };
  if (standIn) cast[0] = hero;
  else if (!cast.length) cast.push(hero);
}
