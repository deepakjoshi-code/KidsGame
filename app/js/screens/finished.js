// "Add my finished book": a child brings in a book they already made (a PDF of their comic,
// photos or scans of the pages, or a typed story) and it becomes a new book draft that opens
// in the editor's review step. Nothing is saved until they press Save there.
import { h, show, button, topbar, toast, pickFile, confirmBox } from "../ui.js";
import * as store from "../store.js";
import { buildBook, parseChunk, detectPlace, detectAction, MAX_PAGES, newId } from "../story.js";
import { countWords } from "../catalog.js";
import { pagePhoto } from "../images.js";
import { ACCEPT, readBookFiles, splitIntoPanels } from "../importbook.js";
import { nav, screen } from "./common.js";

// File-picker filters for each choice, taken from the importer's ACCEPT list.
const ACCEPT_PARTS = String(ACCEPT || "").split(",").map((s) => s.trim()).filter(Boolean);
const acceptOf = (re, dflt) => { const p = ACCEPT_PARTS.filter((x) => re.test(x)); return p.length ? p.join(",") : dflt; };
const ACCEPT_PDF = acceptOf(/pdf/i, "application/pdf,.pdf");
const ACCEPT_IMG = acceptOf(/^image\/|^\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i, "image/*,.heic,.heif");
const ACCEPT_TXT = acceptOf(/^text\/|^\.txt$/i, "text/plain,.txt");

const iconBtn = (icon, name, fn, cls = "ghost icon") => {
  const b = button(icon, fn, "fb-tool " + cls);
  b.setAttribute("aria-label", name);
  b.title = name;
  return b;
};

// Only one import is open at a time. Locking (or leaving) drops its pictures from memory.
let active = null;
let lockHooked = false;

export function finishedBook(profileId) {
  const profile = store.isUnlocked() ? store.get(profileId) : null;
  if (!profile) return nav.picker();
  dispose(active);
  if (!lockHooked) { lockHooked = true; store.onLock(() => dispose(active)); }
  const st = {
    profile, alive: true, run: 0, urls: new Set(),
    title: "", storyText: "", warnings: [], pages: [],
    split: false, cover: true, splitting: null, step: "choose",
    draft: store.beginDraft(),
  };
  active = st;
  st.offDrop = hookDrop(st);
  chooseStep(st);
}

function dispose(st) {
  if (!st) return;
  st.alive = false;
  st.run++;
  for (const u of st.urls) URL.revokeObjectURL(u);
  st.urls.clear();
  st.pages = [];
  st.offDrop?.();
  store.endDraft(st.draft);
  if (active === st) active = null;
}

const objURL = (st, blob) => { const u = URL.createObjectURL(blob); st.urls.add(u); return u; };
const freeURL = (st, u) => { if (u && st.urls.delete(u)) URL.revokeObjectURL(u); };

async function leave(st) {
  if (st.step === "preview" && st.pages.length && !(await confirmBox("Leave without making your book?", "Your pages haven't been saved yet.", "Leave", "danger"))) return;
  const id = st.profile.id;
  dispose(st);
  nav.shelf(id);
}

// Desktop drag-and-drop: files dropped anywhere on the screen are read on the first step.
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
    if (st.alive && st.step === "choose" && files.length) startRead(st, files);
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

// ---------- step 1: what did you make? ----------
function chooseStep(st, error = "") {
  st.step = "choose";
  const choice = (icon, label, sub, accept, multiple) => h("button", {
    type: "button", class: "fb-choice",
    onclick: async () => {
      const files = await pickFile(accept, multiple);
      if (files.length && st.alive && st.step === "choose") startRead(st, files);
    },
  },
  h("span", { class: "fb-choice-ico", "aria-hidden": "true" }, icon),
  h("span", { class: "fb-choice-text" }, h("strong", null, label), h("span", null, sub)));

  show(
    topbar({ title: "Add my finished book", back: () => leave(st) }),
    screen("narrow fb",
      h("div", { class: "fb-hello" },
        h("span", { class: "big-emoji", "aria-hidden": "true" }, "📚"),
        h("h2", null, "Do you already have a finished book?"),
        h("p", null, "Bring it in! We'll turn it into your comic and your game.")),
      error ? h("p", { class: "fb-error", role: "alert" }, "😕 ", error) : null,
      h("div", { class: "fb-choices", role: "group", "aria-label": "What kind of book?" },
        choice("📄", "A PDF of my comic", "A printed or scanned comic, saved as a PDF", ACCEPT_PDF, false),
        choice("🖼️", "Photos or scans of my pages", "Pick all your pages at once. They stay in order.", ACCEPT_IMG, true),
        choice("📝", "My story as a text file", "A story you typed, saved as .txt", ACCEPT_TXT, false)),
      h("div", { class: "fb-drop", "aria-hidden": "true" }, "⬇️ Or drop your files here"),
      h("p", { class: "small muted center-text fb-safe" }, "🔒 Your book stays on this device.")));
}

// ---------- a progress card (reading, finding panels, saving) ----------
function progressBar() {
  const fill = h("div", { class: "fb-bar-fill" });
  const bar = h("div", { class: "fb-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  const label = h("p", { class: "fb-bar-label", "aria-live": "polite" }, "Getting ready…");
  return {
    node: h("div", { class: "fb-progress" }, label, bar),
    set(done, total, text) {
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
      fill.style.width = pct + "%";
      bar.setAttribute("aria-valuenow", String(pct));
      if (text) label.textContent = text;
    },
  };
}

function busyStep(st, title, emoji, onCancel) {
  const prog = progressBar();
  show(
    topbar({ title: "Add my finished book", back: onCancel }),
    screen("narrow fb center",
      h("div", { class: "card stack fb-busy" },
        h("span", { class: "big-emoji fb-bounce", "aria-hidden": "true" }, emoji),
        h("h2", null, title),
        prog.node,
        h("div", { class: "row center" }, button("✋ Cancel", onCancel, "big ghost")))));
  return prog;
}

// ---------- step 2: read the files ----------
async function startRead(st, files) {
  const run = ++st.run;
  st.step = "reading";
  const stale = () => !st.alive || st.run !== run;
  const prog = busyStep(st, "Reading your book…", "📖", () => { st.run++; chooseStep(st); });
  let res;
  try {
    res = await readBookFiles(files, {
      onProgress: ({ done = 0, total = 0, label = "" } = {}) => {
        if (stale()) return;
        const n = Math.min(total, done + 1);
        const text = label && label !== "Done" ? label.replace(/[.…\s]*$/, "…") : "";
        prog.set(done, total, text || (total ? `Reading page ${n} of ${total}…` : "Reading…"));
      },
    });
  } catch (e) {
    if (!stale()) chooseStep(st, e?.message && e.message !== "locked" ? e.message : "That file couldn't be opened. Try another one?");
    return;
  }
  if (stale()) return;
  const warnings = (res?.warnings || []).filter((w) => typeof w === "string" && w.trim());
  const pages = (res?.pages || []).filter((p) => p && p.blob instanceof Blob);
  const storyText = typeof res?.storyText === "string" ? res.storyText : "";
  st.title = String(res?.title || "").trim().slice(0, 80);
  st.storyText = storyText;
  st.warnings = warnings;

  if (!pages.length) {
    if (storyText.trim()) { if (warnings.length) toast(warnings[0]); textBook(st); return; }
    chooseStep(st, warnings[0] || "We couldn't find any pages in that. Try another file?");
    return;
  }
  st.pages = pages.map((p) => ({
    key: newId(), blob: p.blob, url: objURL(st, p.blob),
    source: p.source, text: typeof p.text === "string" ? p.text : "",
    panels: null, whole: false,
  }));
  const fromPdf = pages.some((p) => p.source === "pdf");
  st.split = fromPdf || pages.length > 1;
  st.cover = true;
  previewStep(st);
}

// A typed story: the usual story builder, then straight to the review step.
function textBook(st) {
  const book = buildBook(st.storyText, { title: st.title || "My Story", author: st.profile.name });
  if (!book.pages.length) { chooseStep(st, "That story file looks empty. Try another one?"); return; }
  childHero(book.cast, st.profile);
  suggestGames(book.pages);
  handOff(st, { ...book, profileId: st.profile.id }, []);
}

// ---------- step 3: check the pages ----------
// The pages (or panels) that will become the book, in order.
const cutsPage = (st, p, i) => st.split && !(st.cover && i === 0) && !p.whole && Array.isArray(p.panels) && p.panels.length > 1;
function finalItems(st) {
  const out = [];
  st.pages.forEach((p, i) => {
    if (cutsPage(st, p, i)) p.panels.forEach((c, j) => out.push({ blob: c.blob, text: j === 0 ? p.text : "", page: p, panel: j }));
    else out.push({ blob: p.blob, text: p.text, page: p, panel: -1 });
  });
  return out;
}

function previewStep(st) {
  st.step = "preview";
  const cards = new Map();
  let splitProg = null, notices = null, makeBtn = null;

  const rerender = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };

  function overSet() {
    const items = finalItems(st);
    const over = new Set();
    items.forEach((it, n) => { if (n >= MAX_PAGES) over.add(it.page.key + ":" + it.panel); });
    return { count: items.length, over };
  }

  function paintNotices() {
    const { count } = overSet();
    const list = [...st.warnings];
    const kids = [];
    if (count > MAX_PAGES) {
      kids.push(h("p", { class: "fb-notice-strong" },
        `Your book has ${count} pictures, but a book can have ${MAX_PAGES} pages. We'll keep the first ${MAX_PAGES}.`),
      h("p", { class: "small" }, "To keep different ones, remove some pages or keep some pages whole."));
    }
    if (list.length) kids.push(h("ul", { class: "fb-warn-list" }, list.map((w) => h("li", null, w))));
    notices.replaceChildren(...(kids.length ? [h("span", { class: "fb-notice-ico", "aria-hidden": "true" }, "💡"), h("div", { class: "grow" }, kids)] : []));
    notices.hidden = !kids.length;
  }
  function paintMake() {
    if (!makeBtn) return;
    makeBtn.disabled = !!st.splitting;
    makeBtn.replaceChildren(st.splitting ? h("span", { class: "busy" }, "Finding panels…") : "Make my comic ✨");
  }
  function refreshCard(p) {
    const old = cards.get(p.key);
    const i = st.pages.indexOf(p);
    if (!old || i < 0) return;
    const fresh = pageCard(p, i, overSet().over);
    old.replaceWith(fresh);
  }

  async function runSplit() {
    if (st.splitting || !st.split) return;
    const run = st.run;
    const todo = st.pages.filter((p, i) => p.panels === null && !(st.cover && i === 0));
    if (!todo.length) return;
    st.splitting = { done: 0, total: todo.length };
    paintMake();
    for (const p of todo) {
      if (!st.alive || st.run !== run) return;
      if (!st.pages.includes(p) || p.panels !== null) { st.splitting.done++; continue; }
      const n = st.pages.indexOf(p) + 1;
      splitProg?.set(st.splitting.done, st.splitting.total, `Finding panels on page ${n}…`);
      let parts = [];
      try { parts = await splitIntoPanels(p.blob); } catch { parts = []; }
      if (!st.alive || st.run !== run) return;
      parts = (parts || []).filter((c) => c && c.blob instanceof Blob);
      p.panels = parts.length > 1 ? parts.map((c) => ({ blob: c.blob, url: objURL(st, c.blob) })) : [];
      st.splitting.done++;
      splitProg?.set(st.splitting.done, st.splitting.total);
      refreshCard(p);
      paintNotices();
    }
    st.splitting = null;
    if (st.alive && st.run === run && st.step === "preview") rerender();
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= st.pages.length) return;
    [st.pages[i], st.pages[j]] = [st.pages[j], st.pages[i]];
    rerender();
    runSplit(); // a page that moved off the cover spot may need cutting now
  }
  async function remove(i) {
    if (st.pages.length === 1) { toast("A book needs at least one page."); return; }
    if (!(await confirmBox(`Take out page ${i + 1}?`, "It won't go in your book.", "Take it out", "danger"))) return;
    if (!st.alive || st.step !== "preview") return;
    const [p] = st.pages.splice(i, 1);
    if (p) { freeURL(st, p.url); for (const c of p.panels || []) freeURL(st, c.url); }
    rerender();
    runSplit();
  }

  function pageCard(p, i, over) {
    const isCover = st.cover && i === 0;
    const cut = cutsPage(st, p, i);
    const pageOver = cut ? p.panels.every((_, j) => over.has(p.key + ":" + j)) : over.has(p.key + ":-1");
    let panelsView = null;
    if (st.split) {
      if (isCover) panelsView = h("p", { class: "fb-note" }, "📕 This is your cover, so it stays whole.");
      else if (p.panels === null) panelsView = h("p", { class: "fb-note" }, h("span", { class: "busy" }, "Looking for panels…"));
      else if (!p.panels.length) panelsView = h("p", { class: "fb-note" }, "No panels found, so the whole page is used.");
      else if (p.whole) {
        panelsView = h("div", { class: "fb-note-row" },
          h("p", { class: "fb-note" }, "Whole page kept."),
          button("✂️ Cut it again", () => { p.whole = false; refreshCard(p); paintNotices(); }, "ghost fb-tool-wide"));
      } else {
        panelsView = h("div", { class: "fb-panels-wrap" },
          h("p", { class: "fb-note" }, `✂️ ${p.panels.length} panels`),
          h("div", { class: "fb-panels" }, p.panels.map((c, j) => h("div", { class: "fb-panel" + (over.has(p.key + ":" + j) ? " over" : "") },
            h("img", { src: c.url, alt: `Page ${i + 1}, panel ${j + 1}`, decoding: "async" }),
            h("span", { class: "fb-num" }, String(j + 1))))),
          button("↩️ Undo for this page", () => { p.whole = true; refreshCard(p); paintNotices(); }, "ghost fb-tool-wide"));
      }
    }
    const card = h("section", { class: "fb-page" + (isCover ? " cover" : "") + (pageOver ? " over" : ""), "aria-label": `Page ${i + 1}` },
      h("div", { class: "fb-page-head" },
        h("h3", null, `Page ${i + 1}`),
        isCover ? h("span", { class: "fb-badge" }, "📕 Cover") : null,
        pageOver ? h("span", { class: "fb-badge warn" }, "Won't fit") : null),
      h("div", { class: "fb-thumb" + (cut ? " is-cut" : "") },
        h("img", { src: p.url, alt: `Your page ${i + 1}`, decoding: "async" })),
      panelsView,
      h("div", { class: "fb-tools" },
        iconBtn("◀", `Move page ${i + 1} earlier`, () => move(i, -1)),
        iconBtn("▶", `Move page ${i + 1} later`, () => move(i, 1)),
        iconBtn("🗑️", `Take out page ${i + 1}`, () => remove(i), "ghost icon danger-ghost")));
    card.querySelector(".fb-tools .fb-tool").disabled = i === 0;
    card.querySelectorAll(".fb-tools .fb-tool")[1].disabled = i === st.pages.length - 1;
    cards.set(p.key, card);
    return card;
  }

  function toggle(on, icon, label, sub, fn) {
    return h("button", { type: "button", class: "fb-toggle", role: "switch", "aria-checked": String(on), onclick: fn },
      h("span", { class: "fb-toggle-ico", "aria-hidden": "true" }, icon),
      h("span", { class: "fb-toggle-text" }, h("strong", null, label), h("span", null, sub)),
      h("span", { class: "fb-knob", "aria-hidden": "true" }));
  }

  function render() {
    cards.clear();
    notices = h("div", { class: "fb-notice", role: "status" });
    splitProg = st.splitting ? progressBar() : null;
    if (splitProg) splitProg.set(st.splitting.done, st.splitting.total, "Finding the comic panels…");
    makeBtn = button("Make my comic ✨", () => build(st), "big go grow");
    const { over } = overSet();
    const n = st.pages.length;
    show(
      topbar({ title: "Check your pages", back: () => leave(st) }),
      screen("fb wide-screen",
        h("div", { class: "fb-hello small-hello" },
          h("h2", null, `🎉 We found ${n} ${n === 1 ? "page" : "pages"}!`),
          h("p", null, "Check they're in the right order. Then make your comic!")),
        notices,
        h("div", { class: "fb-options" },
          toggle(st.split, "✂️", "Cut my pages into comic panels", "Each box on your page becomes its own comic page.", () => {
            st.split = !st.split; rerender(); runSplit();
          }),
          toggle(st.cover, "📕", "Use the first page as the cover", "Your first page stays whole, on the front.", () => {
            st.cover = !st.cover; rerender(); runSplit();
          })),
        splitProg ? splitProg.node : null,
        h("div", { class: "fb-grid" }, st.pages.map((p, i) => pageCard(p, i, over))),
        h("div", { class: "save-bar row nowrap" },
          button("↩ Other files", async () => {
            if (!(await confirmBox("Pick different files?", "These pages will be put away.", "Pick again", ""))) return;
            if (!st.alive) return;
            st.run++;
            for (const u of st.urls) URL.revokeObjectURL(u);
            st.urls.clear();
            st.pages = []; st.splitting = null; st.warnings = [];
            chooseStep(st);
          }, "ghost"),
          makeBtn)));
    paintNotices();
    paintMake();
  }

  render();
  runSplit();
}

// ---------- step 4: make the book ----------
async function build(st) {
  if (st.splitting) return;
  const items = finalItems(st).slice(0, MAX_PAGES);
  if (!items.length) return;
  const run = ++st.run;
  const created = [];
  let cancelled = false;
  st.step = "building";
  const back = async () => {
    cancelled = true;
    st.run++;
    await dropImages(created);
    if (st.alive) previewStep(st);
  };
  const prog = busyStep(st, "Making your comic…", "✨", back);
  try {
    for (let i = 0; i < items.length; i++) {
      prog.set(i, items.length, `Putting in page ${i + 1} of ${items.length}…`);
      const { bytes, mime } = await storable(items[i].blob);
      if (cancelled || !st.alive || st.run !== run) break;
      const id = await store.putImage(bytes, mime);
      created.push(id);
      items[i].imageId = id;
      if (cancelled || !st.alive || st.run !== run) break;
    }
  } catch (e) {
    await dropImages(created);
    if (st.alive && st.run === run) {
      toast(e?.message && e.message !== "locked" ? e.message : "Something went wrong. Please try again.");
      previewStep(st);
    }
    return;
  }
  if (cancelled || !st.alive || st.run !== run) { await dropImages(created); return; }
  prog.set(1, 1, "Almost ready…");
  const book = assemble(st, items);
  handOff(st, book, created);
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

function assemble(st, items) {
  const { profile } = st;
  const title = st.title || "My Book";
  const texts = items.map((it) => String(it.text || "").trim());
  const hasText = texts.some(Boolean);

  // Pictures plus a separate typed story: the story makes the pages, pictures go on in order.
  if (!hasText && st.storyText.trim()) {
    const book = buildBook(st.storyText, { title, author: profile.name });
    childHero(book.cast, profile);
    const hero = heroOf(book.cast);
    items.forEach((it, i) => {
      if (book.pages[i]) book.pages[i].imageId = it.imageId;
      else book.pages.push(blank(hero, book.pages[i - 1]?.place, it.imageId));
    });
    book.pages = book.pages.slice(0, MAX_PAGES);
    suggestGames(book.pages);
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
    return { id: newId(), imageId: it.imageId, place, narration: parsed.narration || "", lines, actors: actors.length ? actors : [hero.id], action: detectAction(t) || "none" };
  });
  suggestGames(pages);
  return {
    kind: "book", profileId: profile.id, title, author: profile.name,
    cast, pages, stars: 0, plays: 0, cover: pages[0]?.imageId || null,
  };
}

const heroOf = (cast) => cast.find((c) => c.role === "hero") || cast[0];
function blank(hero, place = "forest", imageId = null) {
  return { id: newId(), imageId, place: place || "forest", narration: "", lines: [], actors: hero ? [hero.id] : [], action: "none" };
}

// No characters found (or only the builder's stand-in "Hero"): the child is the hero,
// with their own profile picture. They can rename or redraw them in the next step.
function childHero(cast, profile) {
  const standIn = cast.length === 1 && cast[0].name === "Hero" && !cast[0].kind;
  const hero = { id: standIn ? cast[0].id : newId(), name: profile.name, emoji: profile.avatar || "🧒", kind: null, faces: "front", flip: false, imageId: null, role: "hero", big: false, words: [] };
  if (standIn) cast[0] = hero;
  else if (!cast.length) cast.push(hero);
}

// A book with no game words still gets a fun game: run and jump at the start, a treasure hunt
// in the middle, a climb later on in longer books, and a fireworks party at the end.
export function suggestGames(pages) {
  const n = pages.length;
  if (!n || pages.some((p) => p.action && p.action !== "none")) return;
  const set = (i, a) => { if (pages[i] && pages[i].action === "none") pages[i].action = a; };
  set(0, "journey");
  if (n >= 3) set(Math.floor((n - 1) / 2), "collect");
  if (n >= 6) set(Math.floor((n - 1) * 0.75), "climb");
  if (n >= 2) set(n - 1, "celebrate");
}

function handOff(st, book, created) {
  const profileId = st.profile.id;
  if (!store.isUnlocked() || !st.alive) return;
  nav.editor({ profileId, book, created, step: "review" });
  dispose(st); // the editor holds its own draft from here
}
