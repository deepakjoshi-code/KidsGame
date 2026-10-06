// A child's bookshelf, and opening/playing a book.
import { h, show, button, topbar, toast } from "../ui.js";
import * as store from "../store.js";
import { loadSprites, renderPanel } from "../art.js";
import { stopSpeech } from "../audio.js";
import { showComic } from "../comic.js";
import { playGame } from "../game.js";
import { nav, session, screen, starsText } from "./common.js";

export function shelf(profileId) {
  const p = store.get(profileId);
  if (!p) return nav.picker();
  session.profileId = p.id;
  const books = store.list("book", (b) => b.profileId === p.id).reverse();
  const cards = books.map((b) => {
    const cover = h("div", { class: "cover" }, h("span", { class: "placeholder", "aria-hidden": "true" }, "📖"));
    const card = h("button", { type: "button", class: "book-card", onclick: () => openBook(b.id), "aria-label": `${b.title}. ${starsText(b.stars)}` },
      cover,
      h("div", { class: "meta" },
        h("div", { class: "title" }, b.title),
        h("div", { class: "stars" }, starsText(b.stars))));
    card.style.borderLeftColor = p.color || "";
    drawCover(b, cover);
    return card;
  });
  show(
    topbar({
      title: `${p.avatar} ${p.name}'s books`,
      back: () => nav.picker(),
      actions: [lockBtn()],
    }),
    screen("",
      h("div", { class: "shelf-actions" },
        button([h("span", { class: "ico", "aria-hidden": "true" }, "✏️"), "Write a new book"], () => nav.editor({ profileId: p.id }), "big go"),
        button([h("span", { class: "ico", "aria-hidden": "true" }, "📷"), "Use photos of my book"], () => nav.editor({ profileId: p.id, photos: true }), "big blue")),
      books.length
        ? h("div", { class: "shelf-grid" }, cards)
        : h("div", { class: "empty card soft" },
          h("span", { class: "big-emoji", "aria-hidden": "true" }, "📚"),
          h("h2", null, "Your shelf is empty"),
          h("p", null, "Write your first story, or take photos of a book you made!"))));
}

function lockBtn() { const b = button("🔒", () => nav.lockNow(), "small ghost icon"); b.setAttribute("aria-label", "Lock"); return b; }

async function drawCover(book, box) {
  const page = book.pages[0];
  if (!page) return;
  try {
    const sprites = await loadSprites(book);
    const c = await renderPanel(page, sprites, 480, 300);
    c.setAttribute("aria-hidden", "true");
    box.replaceChildren(c);
  } catch { /* keep the placeholder */ }
}

export function openBook(id) {
  const book = store.get(id);
  if (!book) return shelf(session.profileId);
  stopSpeech();
  showComic(book, {
    onBack: () => { stopSpeech(); shelf(book.profileId); },
    onPlay: () => play(book.id),
    onEdit: () => { stopSpeech(); nav.editor({ profileId: book.profileId, bookId: book.id }); },
  });
}

function play(id) {
  const book = store.get(id);
  if (!book) return shelf(session.profileId);
  stopSpeech();
  let saved = false;
  playGame(book, {
    onFinish: async (stars) => {
      if (saved || !store.isUnlocked()) return;
      saved = true;
      const fresh = store.get(id);
      if (!fresh) return;
      fresh.stars = Math.max(fresh.stars || 0, Math.max(0, Math.floor(Number(stars) || 0)));
      fresh.plays = (fresh.plays || 0) + 1;
      try { await store.save(fresh); } catch { toast("Couldn't save your stars."); }
    },
    onExit: () => { stopSpeech(); if (store.isUnlocked()) openBook(id); },
  });
}
