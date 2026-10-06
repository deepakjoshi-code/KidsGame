// Comic reader (panels, captions, speech bubbles, page turn, read-aloud), the print layout,
// and portable .wishbook packs (export / strict import).
import { h, show, topbar, toast } from "./ui.js";
import * as store from "./store.js";
import { loadImage, fromDataURL } from "./images.js";
import { loadSprites, renderPanel, layoutActors, SKY_SAFE } from "./art.js";
import { speak, stopSpeech, sfx } from "./audio.js";
import { CAST_BY_KEY, PLACES, ACTIONS } from "./catalog.js";
import { newId, MAX_PAGES, MAX_CAST } from "./story.js";

const PW = 960, PH = 600; // generated panel size (16:10)

// ---------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------

export async function showComic(book, { onBack, onPlay, onEdit } = {}) {
  const pages = Array.isArray(book.pages) ? book.pages : [];
  const castById = new Map((book.cast || []).map((c) => [c.id, c]));
  const sprites = await loadSprites(book);

  let disposed = false;
  const owned = []; // object URLs this reader made; revoked on leave
  const panels = new Map();

  const toURL = (canvas) => new Promise((resolve) => canvas.toBlob((b) => {
    if (!b) return resolve(null);
    const u = URL.createObjectURL(b);
    if (disposed) { URL.revokeObjectURL(u); return resolve(null); }
    owned.push(u); resolve(u);
  }, "image/png"));

  async function makePanel(page) {
    if (page.imageId) {
      const url = await store.imageURL(page.imageId).catch(() => null);
      if (url) {
        try { const img = await loadImage(url); return { src: url, w: img.naturalWidth, h: img.naturalHeight, photo: true }; } catch { /* draw a scene instead */ }
      }
    }
    const c = await renderPanel({ ...page, imageId: null }, sprites, PW, PH);
    return { src: await toURL(c), w: PW, h: PH, photo: false };
  }
  const panel = (i) => {
    if (!panels.has(i)) panels.set(i, makePanel(pages[i]).catch(() => ({ src: null, w: PW, h: PH, photo: false })));
    return panels.get(i);
  };
  let coverP = null;
  const cover = () => (coverP ||= (async () => {
    if (book.cover) {
      const url = await store.imageURL(book.cover).catch(() => null);
      if (url) { try { const img = await loadImage(url); return { src: url, w: img.naturalWidth, h: img.naturalHeight, photo: true }; } catch { /* fall through */ } }
    }
    return pages.length ? panel(0) : null;
  })());

  // Views: 0 = cover, 1..n = pages, n+1 = the end.
  const last = pages.length + 1;
  let at = 0;
  let relayout = () => {};

  const stage = h("main", { class: "comic-stage", "aria-live": "polite" });
  const dots = h("div", { class: "comic-dots", role: "tablist", "aria-label": "Pages" });
  const counter = h("span", { class: "comic-count" });
  const prevBtn = h("button", { type: "button", class: "comic-turn prev", "aria-label": "Previous page", onclick: () => go(at - 1) }, h("span", { "aria-hidden": "true" }, "◀"));
  const nextBtn = h("button", { type: "button", class: "comic-turn next", "aria-label": "Next page", onclick: () => go(at + 1) }, h("span", { "aria-hidden": "true" }, "▶"));
  const readBtn = h("button", { type: "button", class: "comic-read", onclick: () => readAloud() }, h("span", { "aria-hidden": "true" }, "🔊"), " Read to me");
  const printHost = h("div", { class: "comic-print", "aria-hidden": "true" });

  const leave = (fn) => () => { cleanup(); fn?.(); };
  const actions = [];
  if (onEdit) actions.push(h("button", { type: "button", class: "chip comic-chip", onclick: leave(onEdit) }, "✏️ Edit"));
  if (onPlay) actions.push(h("button", { type: "button", class: "chip comic-chip play", onclick: leave(onPlay) }, "▶ Play game"));
  actions.push(h("button", { type: "button", class: "chip comic-chip", onclick: () => printBook() }, "🖨 Print"));
  const bar = topbar({ title: book.title || "My Story", back: leave(onBack), actions });
  bar.classList.add("comic-topbar");

  for (let i = 0; i <= last; i++) {
    dots.appendChild(h("button", {
      type: "button", class: "comic-dot", role: "tab",
      "aria-label": i === 0 ? "Cover" : i === last ? "The end" : `Page ${i}`,
      onclick: () => go(i),
    }));
  }

  const root = h("div", { class: "comic" },
    h("div", { class: "comic-screen" },
      bar,
      stage,
      h("footer", { class: "comic-foot" },
        prevBtn,
        h("div", { class: "comic-mid" }, readBtn, h("div", { class: "comic-dotrow" }, dots, counter)),
        nextBtn)),
    printHost);

  // --- one view -------------------------------------------------------------------------------
  let talkEls = []; // elements in read-aloud order
  let speech = []; // { role, text } in read-aloud order

  function bubble(line) {
    const c = castById.get(line.who);
    const role = c?.role || "friend";
    const text = String(line.text || "");
    const shout = /[A-Z]{2}/.test(text) && text === text.toUpperCase() && text.length < 40;
    return h("div", { class: `comic-bubble role-${role}${shout ? " shout" : ""}`, dataset: { who: line.who || "" } },
      h("span", { class: "comic-who" }, c ? `${c.emoji} ${c.name}` : "Someone"),
      h("span", { class: "comic-text" }, text));
  }
  function talkFor(page) {
    const caption = page.narration ? h("div", { class: "comic-caption" }, page.narration) : null;
    const bubbles = (page.lines || []).filter((l) => l && l.text).map(bubble);
    talkEls = [caption, ...bubbles].filter(Boolean);
    speech = [];
    if (page.narration) speech.push({ role: "narrator", text: page.narration });
    for (const l of (page.lines || []).filter((x) => x && x.text)) speech.push({ role: castById.get(l.who)?.role || "friend", text: String(l.text) });
    return h("div", { class: "comic-talk" }, caption, h("div", { class: "comic-bubbles" }, bubbles));
  }

  // Space for a picture inside the stage (minus padding, frame border and shadow).
  function room() {
    const cs = getComputedStyle(stage);
    const px = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), py = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return [stage.clientWidth - px - 16, stage.clientHeight - py - 16];
  }
  // The frame is a size container (bubble text scales with it), so it needs an explicit width.
  function size(img, w, hh) {
    img.style.width = w + "px"; img.style.height = hh + "px";
    img.parentElement.style.width = w + 8 + "px";
  }
  function fit(aw, ah, iw, ih) {
    const s = Math.max(0.01, Math.min(aw / iw, ah / ih));
    return [Math.max(40, Math.floor(iw * s)), Math.max(30, Math.floor(ih * s))];
  }

  function viewPage(i) {
    const page = pages[i];
    const img = h("img", { class: "comic-img", alt: page.narration || `Page ${i + 1}`, draggable: "false" });
    const frame = h("div", { class: "comic-frame" }, img);
    const talk = talkFor(page);
    const art = h("article", { class: "comic-page", "aria-label": `Page ${i + 1}` }, frame);
    const speakerAt = new Map();
    let info = { w: PW, h: PH, photo: false };

    for (const a of layoutActors(page.actors || [], sprites, PW, PH)) {
      if (!speakerAt.has(a.s.id)) speakerAt.set(a.s.id, a.x / PW);
    }

    relayout = () => {
      if (!art.isConnected) return;
      const [W, H] = room();
      if (W < 60 || H < 60) return;
      const portrait = H > W * 1.05;
      const hasTalk = talkEls.length > 0;
      art.classList.remove("overlay", "below", "beside");
      talk.style.width = ""; talk.style.maxHeight = "";
      // 1. Generated scenes with room to spare: bubbles float in the sky, each above its speaker.
      if (!info.photo && !portrait && hasTalk) {
        const [w, hh] = fit(W, H, info.w, info.h);
        if (w >= 620) {
          size(img, w, hh);
          art.classList.add("overlay");
          frame.appendChild(talk);
          if (placeInSky(w, hh)) return;
          art.classList.remove("overlay");
        }
      }
      // 2. Sideways: words beside the picture. 3. Upright: words under it, large.
      unplace();
      if (hasTalk && !portrait && W > 560) {
        art.classList.add("beside");
        art.appendChild(talk);
        const tw = Math.min(420, Math.max(240, Math.round(W * 0.34)));
        talk.style.width = tw + "px";
        talk.style.maxHeight = H + "px";
        const [w, hh] = fit(W - tw - 16, H, info.w, info.h);
        size(img, w, hh);
      } else {
        art.classList.add("below");
        art.appendChild(talk);
        const th = hasTalk ? talk.offsetHeight + 12 : 0;
        const [w, hh] = fit(W, Math.max(H * 0.45, H - th), info.w, info.h);
        size(img, w, hh);
      }
    };

    const bubbleEls = () => [...talk.querySelectorAll(".comic-bubble")];
    function unplace() {
      for (const b of bubbleEls()) { b.style.left = ""; b.style.top = ""; b.style.removeProperty("--tail"); b.classList.remove("no-tail"); }
    }
    // Comic-style placement: the caption sits in the top-left corner; each bubble goes above its
    // speaker, below anything it would overlap, and never higher than the bubble before it (so
    // reading order stays top-to-bottom). Returns false if the words don't fit in the sky.
    function placeInSky(w, hh) {
      unplace();
      const pad = Math.round(w * 0.015), gap = Math.round(w * 0.012), tail = 18;
      const rects = [];
      const cap = talk.querySelector(".comic-caption");
      if (cap) rects.push({ l: 0, t: 0, r: cap.offsetWidth, b: cap.offsetHeight });
      let minTop = pad;
      for (const b of bubbleEls()) {
        const bw = b.offsetWidth, bh = b.offsetHeight;
        const x = speakerAt.get(b.dataset.who);
        const cx = x === undefined ? w * 0.7 : x * w;
        const left = Math.max(pad, Math.min(w - bw - pad, cx - bw / 2));
        let top = minTop;
        for (let moved = true, n = 0; moved && n < 20; n++) {
          moved = false;
          for (const r of rects) {
            if (left < r.r + gap && left + bw > r.l - gap && top < r.b + gap && top + bh > r.t - gap) { top = r.b + gap; moved = true; }
          }
        }
        b.style.left = Math.round(left) + "px";
        b.style.top = Math.round(top) + "px";
        rects.push({ l: left, t: top, r: left + bw, b: top + bh + tail });
        minTop = top + Math.round(bh * 0.4);
        if (x === undefined) b.classList.add("no-tail");
        else b.style.setProperty("--tail", Math.round(Math.max(24, Math.min(bw - 24, cx - left))) + "px");
      }
      const bottom = Math.max(0, ...rects.map((r) => r.b));
      return bottom <= hh * (SKY_SAFE + 0.04);
    }

    panel(i).then((p) => {
      if (disposed || !art.isConnected) return;
      info = p;
      art.classList.toggle("photo", !!p.photo);
      if (p.src) img.src = p.src;
      relayout();
    });
    return art;
  }

  function viewCover() {
    const img = h("img", { class: "comic-img", alt: "Cover picture", draggable: "false" });
    const frame = h("div", { class: "comic-frame" }, img);
    const head = h("div", { class: "comic-cover-head" },
      h("h2", { class: "comic-title" }, book.title || "My Story"),
      book.author ? h("p", { class: "comic-by" }, "by ", book.author) : null);
    const art = h("article", { class: "comic-page comic-cover", "aria-label": "Cover" }, head, frame);
    talkEls = [head];
    speech = [{ role: "narrator", text: (book.title || "My Story") + (book.author ? `, by ${book.author}.` : ".") }];
    let info = null;
    relayout = () => {
      if (!art.isConnected || !info) return;
      const [W, H0] = room();
      const H = H0 - head.offsetHeight - 12;
      const [w, hh] = fit(W, Math.max(80, H), info.w, info.h);
      size(img, w, hh);
    };
    cover().then((p) => {
      if (disposed || !art.isConnected) return;
      if (!p || !p.src) { frame.hidden = true; return; }
      info = p; img.src = p.src; relayout();
    });
    return art;
  }

  function viewEnd() {
    talkEls = [];
    speech = [{ role: "narrator", text: "The End." }];
    relayout = () => {};
    return h("article", { class: "comic-page comic-end", "aria-label": "The end" },
      h("h2", { class: "comic-title" }, "The End"),
      h("p", { class: "comic-stars", "aria-hidden": "true" }, "⭐ ⭐ ⭐"),
      h("div", { class: "comic-end-actions" },
        onPlay ? h("button", { type: "button", class: "btn comic-big play", onclick: leave(onPlay) }, "▶ Play the game") : null,
        h("button", { type: "button", class: "btn comic-big ghost", onclick: () => go(0) }, "📖 Read again")));
  }

  let lastDir = 0;
  function go(i) {
    if (i < 0 || i > last || disposed) return;
    stopSpeech();
    lastDir = i === at ? 0 : i > at ? 1 : -1;
    at = i;
    const view = i === 0 ? viewCover() : i === last ? viewEnd() : viewPage(i - 1);
    if (lastDir) view.classList.add(lastDir > 0 ? "from-right" : "from-left");
    stage.replaceChildren(view);
    stage.scrollTop = 0;
    relayout();
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === last;
    [...dots.children].forEach((d, k) => { d.classList.toggle("on", k === i); d.setAttribute("aria-selected", k === i ? "true" : "false"); });
    counter.textContent = i === 0 ? "Cover" : i === last ? "The End" : `${i} / ${pages.length}`;
    if (lastDir) sfx.click();
    // Warm up the neighbours so turning is instant.
    if (i < pages.length) panel(i);
    if (i >= 2) panel(i - 2);
  }

  function readAloud() {
    talkEls.forEach((e) => e.classList.remove("speaking"));
    if (!speech.length) return;
    const els = talkEls.slice();
    speak(speech, (k) => {
      if (disposed) return;
      els.forEach((e, j) => e.classList.toggle("speaking", j === k));
      els[k]?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    });
  }

  // --- print ----------------------------------------------------------------------------------
  let printReady = null;
  function buildPrint() {
    return (printReady ||= (async () => {
      const all = [];
      for (let i = 0; i < pages.length; i++) { all.push(await panel(i)); if (disposed) return; }
      const cv = await cover();
      const foot = () => h("footer", { class: "print-foot" }, "Made with Wish Circle");
      const sheets = [h("section", { class: "print-sheet print-cover" },
        h("h1", { class: "print-title" }, book.title || "My Story"),
        book.author ? h("p", { class: "print-by" }, "by ", book.author) : null,
        cv?.src ? h("img", { class: "print-cover-img", src: cv.src, alt: "" }) : null,
        foot())];
      for (let i = 0; i < pages.length; i += 2) {
        const pair = [i, i + 1].filter((k) => k < pages.length).map((k) => {
          const p = pages[k];
          return h("div", { class: "print-panel" + (all[k].photo ? " photo" : "") },
            h("div", { class: "print-imgbox" }, all[k].src ? h("img", { class: "print-img", src: all[k].src, alt: "" }) : null),
            p.narration ? h("div", { class: "comic-caption" }, p.narration) : null,
            (p.lines || []).length ? h("div", { class: "comic-bubbles" }, p.lines.filter((l) => l && l.text).map(bubble)) : null,
            h("span", { class: "print-num" }, String(k + 1)));
        });
        sheets.push(h("section", { class: "print-sheet" }, pair, foot()));
      }
      printHost.replaceChildren(...sheets);
      await Promise.all([...printHost.querySelectorAll("img")].map((im) => im.decode().catch(() => {})));
    })());
  }
  async function printBook() {
    toast("Getting the pages ready to print…");
    await buildPrint();
    if (disposed) return;
    window.print();
  }

  // --- input & lifecycle ----------------------------------------------------------------------
  function onKey(e) {
    if (disposed || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector(".modal-wrap") || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(at - 1); }
  }
  let sx = null, sy = 0, st = 0;
  stage.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") { sx = e.clientX; sy = e.clientY; st = Date.now(); } });
  stage.addEventListener("pointercancel", () => { sx = null; });
  stage.addEventListener("pointerup", (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - st < 900) go(at + (dx < 0 ? 1 : -1));
  });

  let raf = 0;
  const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => relayout()); };
  const ro = "ResizeObserver" in window ? new ResizeObserver(onResize) : null;
  const mo = new MutationObserver(() => { if (!root.isConnected) cleanup(); });

  function cleanup() {
    if (disposed) return;
    disposed = true;
    stopSpeech();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    ro?.disconnect(); mo.disconnect();
    // Another reader may already be showing (it set the class itself).
    if (![...document.querySelectorAll("#app .comic")].some((el) => el !== root)) document.body.classList.remove("wc-comic");
    printHost.replaceChildren();
    for (const u of owned) URL.revokeObjectURL(u);
    owned.length = 0;
  }

  show(root);
  document.body.classList.add("wc-comic");
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  ro?.observe(stage);
  const app = document.getElementById("app");
  if (app) mo.observe(app, { childList: true });
  go(0);
  // Draw the remaining pages in the background, then lay out the print copy (so ⌘P works too).
  (async () => {
    for (let i = 0; i < pages.length && !disposed; i++) await panel(i);
    if (!disposed) buildPrint();
  })();
}

// ---------------------------------------------------------------------------------------------
// Book packs (.wishbook)
// ---------------------------------------------------------------------------------------------

export const PACK_FORMAT = "wishcircle-book";
const MAX_PACK = 40 * 1024 * 1024;
const MAX_STR = 2000;
const MAX_SIDE = 10000;
const MAX_PIXELS = 50e6;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function blobToDataURL(b) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("read"));
    r.readAsDataURL(b);
  });
}

// A portable copy of a book: no profile, play counts or storage ids, just the story and pictures.
export async function exportBookPack(book) {
  const images = {};
  const imgIds = new Map();
  let n = 0;
  const pic = async (id) => {
    if (!id) return null;
    if (imgIds.has(id)) return imgIds.get(id);
    let out = null;
    const blob = await store.imageBlob(id).catch(() => null);
    if (blob && /^image\/(png|jpeg)$/.test(blob.type)) { out = "i" + ++n; images[out] = await blobToDataURL(blob); }
    imgIds.set(id, out);
    return out;
  };
  const castIds = new Map((book.cast || []).map((c, i) => [c.id, "c" + (i + 1)]));
  const cast = [];
  for (const c of book.cast || []) {
    cast.push({
      id: castIds.get(c.id), name: String(c.name || ""), emoji: String(c.emoji || ""), kind: c.kind || null,
      faces: c.faces || "front", flip: !!c.flip, imageId: await pic(c.imageId), role: c.role || "friend",
      big: !!c.big, words: Array.isArray(c.words) ? c.words.map(String) : [],
    });
  }
  const pages = [];
  for (const [i, p] of (book.pages || []).entries()) {
    pages.push({
      id: "p" + (i + 1), imageId: await pic(p.imageId), place: p.place, narration: String(p.narration || ""),
      lines: (p.lines || []).filter((l) => castIds.has(l.who)).map((l) => ({ who: castIds.get(l.who), text: String(l.text || "") })),
      actors: (p.actors || []).filter((a) => castIds.has(a)).map((a) => castIds.get(a)),
      action: p.action || "none",
    });
  }
  return JSON.stringify({
    format: PACK_FORMAT, v: 1,
    title: String(book.title || ""), author: String(book.author || ""),
    cover: await pic(book.cover), cast, pages, images,
  });
}

// --- strict validation helpers ----------------------------------------------------------------
class PackError extends Error {}
const fail = (msg) => { throw new PackError(msg); };
const BROKEN = "This book file is damaged or isn't a Wish Circle book.";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function onlyKeys(o, allowed, what) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what} has something unexpected in it ("${k.slice(0, 20)}").`);
}
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HAS_CTRL = /[\u0000-\u001F\u007F]/;
function str(v, max, what, { required = false } = {}) {
  if (typeof v !== "string") fail(`${what} should be text.`);
  const s = v.replace(CTRL, "").replace(/\r\n?/g, "\n").trim();
  if (s.length > max) fail(`${what}: too long (at most ${max} letters).`);
  if (required && !s) fail(`${what} is empty.`);
  return s;
}
const PICTO = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
function emoji(v, what) {
  if (typeof v !== "string" || !v || v.length > 16 || HAS_CTRL.test(v) || !PICTO.test(v) || /[\p{L}\p{Nd}]{2}/u.test(v)) {
    fail(`${what} needs a single emoji picture.`);
  }
  return v;
}
function arr(v, max, what) {
  if (!Array.isArray(v)) fail(`${what} should be a list.`);
  if (v.length > max) fail(`${what}: too many (at most ${max}).`);
  return v;
}
const bool = (v, what) => { if (typeof v !== "boolean") fail(`${what} should be yes or no.`); return v; };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function dims(bytes, mime) {
  const b = bytes;
  if (mime === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || sig.some((x, i) => b[i] !== x)) return null;
    return [((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0];
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
    i += 2 + len;
  }
  return null;
}
function checkImage(dataURL) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataURL);
  if (!m) fail("A picture in this book file is damaged.");
  let bin;
  try { bin = atob(m[2]); } catch { fail("A picture in this book file is damaged."); }
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const d = dims(u, m[1]);
  if (!d || !d[0] || !d[1]) fail("A picture in this book file is damaged.");
  if (d[0] > MAX_SIDE || d[1] > MAX_SIDE || d[0] * d[1] > MAX_PIXELS) fail("A picture in this book file is too big.");
}

// Check a parsed pack and return a clean book (pack ids still in place). Throws PackError.
export function validatePack(data) {
  if (!isObj(data) || data.format !== PACK_FORMAT) fail(BROKEN);
  if (data.v !== 1) fail("This book was made by a newer Wish Circle. Please update the app.");
  onlyKeys(data, ["format", "v", "title", "author", "cover", "cast", "pages", "images"], "The book");
  const title = str(data.title, 80, "The title") || "My Story";
  const author = own(data, "author") ? str(data.author, 80, "The author's name") : "";
  if (!isObj(data.images)) fail(BROKEN);
  const imgKeys = Object.keys(data.images);
  if (imgKeys.length > MAX_PAGES + MAX_CAST + 1) fail("This book file has too many pictures.");
  for (const k of imgKeys) {
    if (!ID_RE.test(k) || typeof data.images[k] !== "string") fail(BROKEN);
  }
  const used = new Map(); // pack image id → "sprite" | "page"
  const ref = (v, use, what) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string" || !ID_RE.test(v) || !own(data.images, v)) fail(`A picture for ${what} is missing from this book file.`);
    used.set(v + "|" + use, { id: v, use });
    return v;
  };

  const castIn = arr(data.cast, MAX_CAST, "The cast");
  if (!castIn.length) fail("This book has no characters.");
  const ids = new Set();
  const cast = castIn.map((c, i) => {
    const what = `Character ${i + 1}`;
    if (!isObj(c)) fail(BROKEN);
    onlyKeys(c, ["id", "name", "emoji", "kind", "faces", "flip", "imageId", "role", "big", "words"], what);
    if (typeof c.id !== "string" || !ID_RE.test(c.id) || ids.has(c.id)) fail(BROKEN);
    ids.add(c.id);
    const kind = c.kind === null || c.kind === undefined ? null : c.kind;
    if (kind !== null && (typeof kind !== "string" || !own(CAST_BY_KEY, kind))) fail(`${what} is an unknown kind of character.`);
    const faces = c.faces ?? "front";
    if (!["left", "right", "front"].includes(faces)) fail(`${what} faces a strange way.`);
    const role = c.role;
    if (!["hero", "friend", "villain"].includes(role)) fail(`${what} needs to be a hero, friend or villain.`);
    const words = c.words === undefined ? [] : arr(c.words, 24, `${what}'s words`).map((w) => str(w, 40, `${what}'s words`)).filter(Boolean);
    return {
      id: c.id, name: str(c.name, 40, `${what}'s name`, { required: true }), emoji: emoji(c.emoji, what), kind, faces,
      flip: c.flip === undefined ? false : bool(c.flip, `${what}'s flip`), imageId: ref(c.imageId, "sprite", c.name || what),
      role, big: c.big === undefined ? false : bool(c.big, `${what}'s size`), words,
    };
  });
  if (!cast.some((c) => c.role === "hero")) (cast.find((c) => c.role !== "villain") || cast[0]).role = "hero";
  const hero = cast.find((c) => c.role === "hero");

  const pagesIn = arr(data.pages, MAX_PAGES, "The pages");
  if (!pagesIn.length) fail("This book has no pages.");
  const pids = new Set();
  const pages = pagesIn.map((p, i) => {
    const what = `Page ${i + 1}`;
    if (!isObj(p)) fail(BROKEN);
    onlyKeys(p, ["id", "imageId", "place", "narration", "lines", "actors", "action"], what);
    if (typeof p.id !== "string" || !ID_RE.test(p.id) || pids.has(p.id)) fail(BROKEN);
    pids.add(p.id);
    if (typeof p.place !== "string" || !own(PLACES, p.place)) fail(`${what} is set in a place this app doesn't know.`);
    const action = p.action ?? "none";
    if (typeof action !== "string" || (action !== "none" && !own(ACTIONS, action))) fail(`${what} has a game this app doesn't know.`);
    const lines = (p.lines === undefined ? [] : arr(p.lines, 30, `${what}'s speech`)).map((l) => {
      if (!isObj(l)) fail(BROKEN);
      onlyKeys(l, ["who", "text"], `${what}'s speech`);
      if (typeof l.who !== "string" || !ids.has(l.who)) fail(`${what} has someone talking who isn't in the cast.`);
      return { who: l.who, text: str(l.text, MAX_STR, `Something said on ${what.toLowerCase()}`) };
    }).filter((l) => l.text);
    const actors = [];
    for (const a of p.actors === undefined ? [] : arr(p.actors, MAX_CAST, `${what}'s characters`)) {
      if (typeof a !== "string" || !ids.has(a)) fail(`${what} has a character who isn't in the cast.`);
      if (!actors.includes(a)) actors.push(a);
    }
    return {
      id: p.id, imageId: ref(p.imageId, "page", what.toLowerCase()), place: p.place,
      narration: p.narration === undefined ? "" : str(p.narration, MAX_STR, `The story words on ${what.toLowerCase()}`),
      lines, actors: actors.length ? actors : [hero.id], action,
    };
  });
  const cover = ref(data.cover, "page", "the cover");
  for (const { id } of used.values()) checkImage(data.images[id]);
  return { title, author, cover, cast, pages, images: data.images, uses: [...used.values()] };
}

// Import a .wishbook: strict checks, every picture re-encoded on this device, all-new ids.
export async function importBookPack(text, profileId) {
  if (typeof profileId !== "string" || !profileId) throw new Error("Choose who this book is for first.");
  if (typeof text !== "string" || !text) throw new Error(BROKEN);
  if (text.length > MAX_PACK) throw new Error("This book file is too big (more than 40 MB).");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(BROKEN); }
  let v;
  try { v = validatePack(data); } catch (e) { throw new Error(e instanceof PackError ? e.message : BROKEN); }
  data = null;

  const stored = [];
  const newImg = new Map();
  try {
    for (const { id, use } of v.uses) {
      let enc;
      try { enc = await fromDataURL(v.images[id], use === "sprite"); } catch { throw new PackError("A picture in this book file couldn't be opened."); }
      const sid = await store.putImage(enc.bytes, use === "sprite" ? "image/png" : "image/jpeg");
      stored.push(sid);
      newImg.set(id + "|" + use, sid);
    }
    const img = (id, use) => (id ? newImg.get(id + "|" + use) || null : null);
    const castMap = new Map(v.cast.map((c) => [c.id, newId()]));
    const book = {
      kind: "book", profileId, title: v.title, author: v.author,
      stars: 0, plays: 0, cover: img(v.cover, "page"),
      cast: v.cast.map((c) => ({ ...c, id: castMap.get(c.id), imageId: img(c.imageId, "sprite") })),
      pages: v.pages.map((p) => ({
        ...p, id: newId(), imageId: img(p.imageId, "page"),
        lines: p.lines.map((l) => ({ who: castMap.get(l.who), text: l.text })),
        actors: p.actors.map((a) => castMap.get(a)),
      })),
    };
    return await store.save(book);
  } catch (e) {
    for (const sid of stored) await store.deleteImage(sid).catch(() => {});
    if (e instanceof PackError) throw new Error(e.message);
    if (e?.message === "locked") throw new Error("Wish Circle is locked. Unlock it and try again.");
    throw new Error("That book couldn't be added. Please try again.");
  }
}
