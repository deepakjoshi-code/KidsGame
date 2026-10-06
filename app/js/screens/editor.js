// Story editor: Step 1 write (text and/or page photos) → Step 2 review (cast + pages) → save.
import { h, show, button, topbar, toast, pickFile, confirmBox, modal } from "../ui.js";
import * as store from "../store.js";
import { buildBook, EXAMPLE_STORY, newId, MAX_PAGES, MAX_CAST } from "../story.js";
import { CAST, FALLBACK_EMOJI, PLACES, PLACE_KEYS, ACTIONS, ACTION_KEYS } from "../catalog.js";
import { pagePhoto, spriteFromDrawing } from "../images.js";
import { loadSprites, drawSprite, renderPanel } from "../art.js";
import { nav, screen, field, busy } from "./common.js";
import { deleteBookData } from "./profiles.js";

const ROLES = [["hero", "⭐ Hero"], ["friend", "🙂 Friend"], ["villain", "😈 Baddie"]];
// Icon-only button with a spoken name.
const iconBtn = (icon, name, fn, cls = "small icon ghost") => { const b = button(icon, fn, cls); b.setAttribute("aria-label", name); return b; };
const imageIdsOf = (b) => new Set([b.cover, ...b.pages.map((p) => p.imageId), ...b.cast.map((c) => c.imageId)].filter(Boolean));

// While an edit is open, the store's unused-image sweep stays off (the draft's new photos and
// drawings aren't in any saved book yet). Only one editor screen exists at a time.
let openDraft = null;
function endEdit() { if (openDraft) store.endDraft(openDraft); openDraft = null; }

// A prepared new book (e.g. from "Add my finished book") opens straight at the review step:
// editor({ profileId, book, created: [imageIds it stored], step: "review" }). Those images are
// treated like ones added here: leaving without saving deletes them.
export function editor({ profileId, bookId, photos = false, book = null, created: prepared = [], step = null }) {
  const profile = store.get(profileId);
  if (!profile) return nav.picker();
  const original = bookId ? store.get(bookId) : null;
  const created = new Set(original ? [] : prepared); // images stored during this edit and not yet part of a saved book
  endEdit();
  openDraft = store.beginDraft();
  const ed = { profile, original, created, dirty: false, photosFirst: photos };
  if (original) { ed.draft = structuredClone(original); reviewStep(ed); }
  else if (book && (step === "review" || step === null)) {
    ed.draft = { ...structuredClone(book), profileId: profile.id };
    ed.imported = true;
    ed.dirty = true;
    reviewStep(ed);
  } else { ed.write = { title: "", author: profile.name, text: "", photos: [] }; writeStep(ed); }
}

async function discard(ed) {
  for (const id of ed.created) { try { await store.deleteImage(id); } catch { /* locked */ } }
  ed.created.clear();
}

async function leave(ed) {
  const hasStuff = ed.dirty || ed.created.size || (ed.write && (ed.write.text.trim() || ed.write.photos.length));
  if (hasStuff && !(await confirmBox("Leave without saving?", "Your changes to this book will be lost.", "Leave", "danger"))) return;
  await discard(ed);
  endEdit();
  if (ed.original) nav.openBook(ed.original.id);
  else nav.shelf(ed.profile.id);
}

// ---------- shared image helpers ----------
async function addImage(ed, file, kind) {
  const { bytes, mime } = kind === "sprite" ? await spriteFromDrawing(file) : await pagePhoto(file);
  const id = await store.putImage(bytes, mime);
  ed.created.add(id);
  return id;
}
function thumb(id, alt = "") {
  const img = h("img", { alt, decoding: "async" });
  store.imageURL(id).then((u) => { if (u) img.src = u; }).catch(() => {});
  return img;
}

// ---------- Step 1: write ----------
function writeStep(ed) {
  const w = ed.write;
  const title = h("input", { class: "input", value: w.title, maxlength: 80, placeholder: "My Big Adventure", autocomplete: "off", oninput: (e) => { w.title = e.target.value; } });
  const author = h("input", { class: "input", value: w.author, maxlength: 60, autocomplete: "off", oninput: (e) => { w.author = e.target.value; } });
  const text = h("textarea", {
    class: "input story", value: w.text, rows: 12, maxlength: 20000, spellcheck: "true",
    placeholder: "Once upon a time…\n\nLeave an empty line between pages.\n\nWrite who is talking like this:\nPip: Let's go on an adventure!",
    oninput: (e) => { w.text = e.target.value; },
  });
  const err = h("p", { class: "error", role: "alert" });
  const strip = h("div", { class: "photo-strip" });
  const paintStrip = () => {
    strip.replaceChildren(...w.photos.map((id, i) => h("div", { class: "photo-thumb" },
      thumb(id, `Photo of page ${i + 1}`),
      h("span", { class: "num" }, `Page ${i + 1}`),
      iconBtn("✕", `Remove photo ${i + 1}`, () => { w.photos.splice(i, 1); store.deleteImage(id).catch(() => {}); ed.created.delete(id); paintStrip(); }, "small icon danger remove"))));
    strip.hidden = !w.photos.length;
  };
  const addBtn = button([h("span", { class: "ico", "aria-hidden": "true" }, "📷"), w.photos.length ? "Add more photos" : "Add photos of my pages"], async () => {
    const files = await pickFile("image/*", true);
    if (!files.length) return;
    await busy(addBtn, "Adding photos…", async () => {
      for (const f of files) {
        if (w.photos.length >= MAX_PAGES) { toast(`A book can have up to ${MAX_PAGES} pages.`); break; }
        try { w.photos.push(await addImage(ed, f, "photo")); } catch (x) { toast(x.message || "That picture couldn't be used."); }
      }
    });
    paintStrip();
  }, ed.photosFirst ? "big blue wide" : "blue");
  const example = button("💡 Try an example", async () => {
    if (w.text.trim() && !(await confirmBox("Use the example?", "This replaces the story you've typed.", "Replace", ""))) return;
    w.text = EXAMPLE_STORY; text.value = EXAMPLE_STORY;
    if (!w.title.trim()) { w.title = "Pip's Big Adventure"; title.value = w.title; }
    text.focus();
  }, "small ghost");
  const make = button("Make my book ✨", () => {
    if (!w.text.trim() && !w.photos.length) { err.textContent = "Write your story or add photos of your pages first."; text.focus(); return; }
    ed.draft = makeDraft(w, ed.profile);
    ed.dirty = true;
    reviewStep(ed);
  }, "big go wide");

  const photoSection = h("section", { class: "card stack ed-section" },
    h("h2", null, "📷 Photos of my book", h("span", { class: "muted small" }, ed.photosFirst ? "" : "(optional)")),
    h("p", { class: "small" }, "One photo per page, in order. Photo 1 goes on page 1, photo 2 on page 2, and so on. Extra photos become extra pages. Hidden location data is removed from every photo."),
    addBtn, strip);
  const textSection = h("section", { class: "card stack ed-section" },
    h("div", { class: "row between" }, h("h2", { class: "grow" }, "✏️ My story", ed.photosFirst ? h("span", { class: "muted small" }, "(optional)") : null), example),
    field("Story", text, "Tip: an empty line starts a new page. Words like fight, treasure, climb or party turn into games!"));

  show(
    topbar({ title: "Write a book", back: () => leave(ed) }),
    screen("narrow",
      h("div", { class: "card stack" },
        field("Title", title),
        field("Author", author)),
      ed.photosFirst ? [photoSection, textSection] : [textSection, photoSection],
      err,
      h("div", { class: "save-bar" }, make)));
  paintStrip();
  if (!ed.photosFirst) setTimeout(() => (w.title ? text : title).focus(), 60);
}

function makeDraft(w, profile) {
  const book = buildBook(w.text, { title: w.title, author: w.author || profile.name });
  const hero = book.cast.find((c) => c.role === "hero") || book.cast[0];
  w.photos.forEach((id, i) => {
    if (book.pages[i]) book.pages[i].imageId = id;
    else book.pages.push(blankPage(hero, book.pages[i - 1]?.place, id));
  });
  if (!book.pages.length) book.pages.push(blankPage(hero));
  book.cover = book.pages[0]?.imageId || null;
  book.profileId = profile.id;
  return book;
}
function blankPage(hero, place = "forest", imageId = null) {
  return { id: newId(), imageId, place: place || "forest", narration: "", lines: [], actors: hero ? [hero.id] : [], action: "none" };
}

// ---------- Step 2: review ----------
function reviewStep(ed) {
  const b = ed.draft;
  let spritesP = null;
  const sprites = () => (spritesP ||= loadSprites(b));
  const castChanged = () => { spritesP = null; ed.dirty = true; };
  const touch = () => { ed.dirty = true; };
  const previews = new Map();

  const rerender = () => {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  };

  async function paintPreview(page) {
    const box = previews.get(page.id);
    if (!box) return;
    try {
      const c = await renderPanel(page, await sprites(), 480, 300);
      c.className = "page-preview";
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", "Picture for this page");
      box.replaceChildren(c);
    } catch { /* keep old */ }
  }
  async function paintCast(c, canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      const map = await loadSprites({ cast: [c] });
      drawSprite(ctx, map.get(c.id), canvas.width / 2, canvas.height * 0.94, canvas.height * 0.72);
    } catch { /* ignore */ }
  }
  const repaintAllPreviews = () => b.pages.forEach(paintPreview);

  // ----- cast -----
  function castCard(c) {
    const canvas = h("canvas", { class: "cast-preview", width: 168, height: 168, role: "img", "aria-label": `${c.name} picture` });
    const name = h("input", { class: "input", value: c.name, maxlength: 30, "aria-label": "Name", oninput: (e) => { c.name = e.target.value; touch(); } });
    name.addEventListener("change", () => { if (!c.name.trim()) { c.name = "Friend"; name.value = c.name; } rerender(); });
    const role = h("select", { class: "input", "aria-label": `${c.name}'s role`, onchange: (e) => {
      c.role = e.target.value;
      if (c.role === "hero") for (const o of b.cast) if (o !== c && o.role === "hero") o.role = "friend";
      castChanged(); rerender();
    } }, ROLES.map(([v, l]) => h("option", { value: v, selected: c.role === v }, l)));
    const redraw = () => { paintCast(c, canvas); castChanged(); repaintAllPreviews(); };
    const drawingBtn = button(c.imageId ? "🎨 New drawing" : "🎨 Use my drawing", async () => {
      const [f] = await pickFile("image/*");
      if (!f) return;
      await busy(drawingBtn, "Cutting out…", async () => {
        try { c.imageId = await addImage(ed, f, "sprite"); castChanged(); rerender(); }
        catch (x) { toast(x.message || "That picture couldn't be used."); }
      });
    }, "small blue");
    const card = h("div", { class: "card soft cast-card" + (c.role === "hero" ? " role-hero" : "") },
      h("div", { class: "cast-head" },
        canvas,
        h("div", { class: "grow stack" }, name, role)),
      h("div", { class: "row" },
        button(c.imageId ? "Pick emoji" : `${c.emoji} Change`, () => pickEmoji(c, () => { c.imageId = null; castChanged(); rerender(); }), "small ghost"),
        button("↔ Turn around", () => { c.flip = !c.flip; redraw(); }, "small ghost"),
        drawingBtn,
        c.imageId ? button("Remove drawing", () => { c.imageId = null; castChanged(); rerender(); }, "small ghost") : null,
        b.cast.length > 1 ? iconBtn("🗑", `Remove ${c.name}`, () => removeCast(c)) : null));
    paintCast(c, canvas);
    return card;
  }
  async function removeCast(c) {
    const used = b.pages.some((p) => p.lines.some((l) => l.who === c.id));
    if (!(await confirmBox(`Remove ${c.name}?`, used ? `${c.name}'s speech will be given to someone else.` : null, "Remove"))) return;
    b.cast = b.cast.filter((x) => x !== c);
    if (c.role === "hero" || !b.cast.some((x) => x.role === "hero")) {
      const nh = b.cast.find((x) => x.role !== "villain") || b.cast[0];
      if (nh) nh.role = "hero";
    }
    const fallback = b.cast.find((x) => x.role === "hero") || b.cast[0];
    for (const p of b.pages) {
      p.actors = p.actors.filter((a) => a !== c.id);
      if (!p.actors.length && fallback) p.actors.push(fallback.id);
      for (const l of p.lines) if (l.who === c.id) l.who = fallback.id;
    }
    castChanged(); rerender();
  }
  function addCast() {
    if (b.cast.length >= MAX_CAST) { toast(`Up to ${MAX_CAST} characters.`); return; }
    b.cast.push({ id: newId(), name: "New friend", emoji: FALLBACK_EMOJI[b.cast.length % FALLBACK_EMOJI.length], kind: null, faces: "front", flip: false, imageId: null, role: "friend", big: false, words: [] });
    castChanged(); rerender();
  }

  // ----- pages -----
  function pageCard(p, i) {
    const preview = h("div", null, h("div", { class: "page-preview" }));
    previews.set(p.id, preview);
    const place = h("select", { class: "input", onchange: (e) => { p.place = e.target.value; touch(); paintPreview(p); } },
      PLACE_KEYS.map((k) => h("option", { value: k, selected: p.place === k }, PLACES[k].label)));
    const narration = h("textarea", { class: "input", rows: 3, value: p.narration, maxlength: 2000, oninput: (e) => { p.narration = e.target.value; touch(); } });
    const action = h("select", { class: "input", onchange: (e) => { p.action = e.target.value; touch(); } },
      h("option", { value: "none", selected: !p.action || p.action === "none" }, "No game"),
      ACTION_KEYS.map((k) => h("option", { value: k, selected: p.action === k }, `${ACTIONS[k].icon} ${ACTIONS[k].label}`)));
    const chips = h("div", { class: "actor-chips", role: "group", "aria-label": "Who's in the picture" }, b.cast.map((c) => {
      const on = p.actors.includes(c.id);
      return h("button", { type: "button", class: "chip", "aria-pressed": String(on), onclick: (e) => {
        if (p.actors.includes(c.id)) p.actors = p.actors.filter((a) => a !== c.id);
        else p.actors.push(c.id);
        e.currentTarget.setAttribute("aria-pressed", String(p.actors.includes(c.id)));
        touch(); paintPreview(p);
      } }, `${c.emoji} ${c.name}`);
    }));
    const lines = h("div", { class: "stack" }, p.lines.map((l, j) => lineRow(p, l, j)));
    const photoBtn = button(p.imageId ? "📷 Replace photo" : "📷 Add photo", async () => {
      const [f] = await pickFile("image/*");
      if (!f) return;
      await busy(photoBtn, "Adding…", async () => {
        try { p.imageId = await addImage(ed, f, "photo"); touch(); rerender(); }
        catch (x) { toast(x.message || "That picture couldn't be used."); }
      });
    }, "small blue");
    const card = h("section", { class: "card page-card", "aria-label": `Page ${i + 1}` },
      h("div", { class: "page-head" },
        h("h3", null, `Page ${i + 1}`),
        iconBtn("↑", `Move page ${i + 1} up`, () => move(i, -1)),
        iconBtn("↓", `Move page ${i + 1} down`, () => move(i, 1)),
        iconBtn("🗑", `Delete page ${i + 1}`, () => removePage(i))),
      h("div", { class: "page-body" },
        h("div", { class: "stack" },
          preview,
          h("div", { class: "row" }, photoBtn, p.imageId ? button("Remove photo", () => { p.imageId = null; touch(); rerender(); }, "small ghost") : null),
          p.imageId ? h("p", { class: "small muted" }, "This page shows your photo. Remove it to see a drawn scene.") : null),
        h("div", { class: "stack" },
          field("Place", place),
          h("div", { class: "field" }, h("span", { class: "label" }, "Who's in the picture"), chips),
          field("What happens (narration)", narration),
          h("div", { class: "field" }, h("span", { class: "label" }, "Speech bubbles"), lines,
            button("+ Add speech", () => { p.lines.push({ who: (p.actors[0] || b.cast[0].id), text: "" }); touch(); rerender(); }, "small ghost")),
          field("Game here", action))));
    return card;
  }
  function lineRow(p, l, j) {
    const who = h("select", { class: "input", "aria-label": "Who says it", onchange: (e) => { l.who = e.target.value; touch(); } },
      b.cast.map((c) => h("option", { value: c.id, selected: l.who === c.id }, `${c.emoji} ${c.name}`)));
    const text = h("input", { class: "input line-text", value: l.text, maxlength: 300, "aria-label": "What they say", placeholder: "What do they say?", oninput: (e) => { l.text = e.target.value; touch(); } });
    return h("div", { class: "line-row" }, who, text,
      iconBtn("✕", "Remove this speech bubble", () => { p.lines.splice(j, 1); touch(); rerender(); }));
  }
  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= b.pages.length) return;
    [b.pages[i], b.pages[j]] = [b.pages[j], b.pages[i]];
    touch(); rerender();
  }
  async function removePage(i) {
    const p = b.pages[i];
    if (b.pages.length === 1) { toast("A book needs at least one page."); return; }
    const hasStuff = p.narration.trim() || p.lines.length || p.imageId;
    if (hasStuff && !(await confirmBox(`Delete page ${i + 1}?`, "Its words and photo will be removed from the book.", "Delete"))) return;
    b.pages.splice(i, 1);
    touch(); rerender();
  }
  function addPage() {
    if (b.pages.length >= MAX_PAGES) { toast(`A book can have up to ${MAX_PAGES} pages.`); return; }
    const hero = b.cast.find((c) => c.role === "hero") || b.cast[0];
    b.pages.push(blankPage(hero, b.pages[b.pages.length - 1]?.place));
    touch(); rerender();
    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 30);
  }

  async function save(btn) {
    b.title = (b.title || "").trim() || "My Story";
    b.author = (b.author || "").trim();
    for (const p of b.pages) p.lines = p.lines.filter((l) => l.text.trim());
    b.cover = b.pages[0]?.imageId || null;
    await busy(btn, "Saving…", async () => {
      const saved = await store.save({ ...b, kind: "book", profileId: ed.profile.id, stars: b.stars || 0, plays: b.plays || 0 });
      // Drop images this book no longer uses (replaced photos, removed drawings).
      const keep = imageIdsOf(saved);
      const candidates = new Set([...ed.created, ...(ed.original ? imageIdsOf(ed.original) : [])]);
      for (const id of candidates) if (!keep.has(id)) await store.deleteImage(id).catch(() => {});
      ed.created.clear();
      ed.dirty = false;
      endEdit();
      toast("Your book is saved! 📚");
      nav.openBook(saved.id);
    });
  }
  async function deleteBook() {
    if (!(await confirmBox(`Delete "${ed.original.title}"?`, "The book, its drawings and its photos will be gone for good.", "Delete book"))) return;
    await discard(ed);
    await deleteBookData(ed.original);
    endEdit();
    toast("Book deleted.");
    nav.shelf(ed.profile.id);
  }

  function back() {
    if (!ed.original && ed.write) {
      // Back to the words: keep any photos; the draft is rebuilt from the text next time.
      for (const id of [...ed.created]) if (!ed.write.photos.includes(id)) { store.deleteImage(id).catch(() => {}); ed.created.delete(id); }
      ed.dirty = false;
      writeStep(ed);
    } else leave(ed);
  }

  function render() {
    previews.clear();
    const title = h("input", { class: "input", value: b.title, maxlength: 80, oninput: (e) => { b.title = e.target.value; touch(); } });
    const author = h("input", { class: "input", value: b.author, maxlength: 60, oninput: (e) => { b.author = e.target.value; touch(); } });
    const saveBtn = button("Save my book 📚", () => save(saveBtn), "big go grow");
    show(
      topbar({ title: ed.original ? "Edit book" : "Check your book", back }),
      screen("",
        ed.imported ? h("div", { class: "card sun stack ed-welcome" },
          h("h2", null, "📚 Your pages are in!"),
          h("p", null, "Now make it yours: give your characters names, type what each page says if you like, and pick a game for some pages. Then press Save.")) : null,
        h("div", { class: "card stack" },
          h("div", { class: "two-col" }, field("Title", title), field("Author", author))),
        h("section", { class: "ed-section" },
          h("h2", null, "🎭 Characters"),
          h("p", { class: "small muted" }, "Pick how each character looks. Use a drawing to put your own art in the comic and the game."),
          h("div", { class: "cast-list" }, b.cast.map(castCard)),
          h("div", { class: "row picker-foot" }, button("+ Add character", addCast, "ghost"))),
        h("section", { class: "ed-section stack" },
          h("h2", null, "📄 Pages"),
          b.pages.map(pageCard),
          h("div", { class: "row" }, button("+ Add page", addPage, "ghost"))),
        h("div", { class: "save-bar row nowrap" },
          ed.original ? button("🗑 Delete", deleteBook, "danger") : null,
          saveBtn)));
    repaintAllPreviews();
  }
  render();
}

// Emoji choice for a character (catalog characters first, then a few extras).
function pickEmoji(c, onPick) {
  let m;
  const choose = (opt) => {
    if (opt) { c.emoji = opt.emoji; c.kind = opt.key; c.faces = opt.faces; c.big = !!opt.big; c.words = opt.words; }
    m.close(); onPick();
  };
  const opts = [
    ...CAST.map((x) => ({ emoji: x.emoji, label: x.label, key: x.key, faces: x.faces, big: x.big, words: x.words })),
    ...FALLBACK_EMOJI.map((e) => ({ emoji: e, label: "Other", key: null, faces: "front", big: false, words: [] })),
  ];
  m = modal(h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Choose a character" },
    h("h2", null, `How does ${c.name} look?`),
    h("div", { class: "emoji-grid" }, opts.map((o) => h("button", { type: "button", class: "emoji-opt", "aria-label": o.label, onclick: () => choose(o) },
      h("span", { class: "e", "aria-hidden": "true" }, o.emoji), h("span", { class: "l" }, o.label)))),
    h("div", { class: "row end" }, button("Cancel", () => m.close(), "ghost"))), () => m.close());
  m.wrap.querySelector(".emoji-opt")?.focus();
}
