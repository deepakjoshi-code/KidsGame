// The game: a book's comic pages play in order, and each action moment becomes a short level
// with big buttons. Levels: journey, battle, collect, climb, friends, celebrate. No failure states.
import { h, show } from "./ui.js";
import * as art from "./art.js";
import { sfx, talk, say, stopSpeech, settings, setSetting, audio } from "./audio.js";
import { PLACES, WEAPONS, ITEMS, ACTIONS, pickByWords } from "./catalog.js";
import { planGame } from "./story.js";

const W = 960, H = 540;
const G = art.groundY(H);
const INK = art.INK || "#3b2a1e";
const DISPLAY = '"Chalkboard SE", "Comic Sans MS", "Marker Felt", cursive';
const NEXT_KEYS = [" ", "Enter", "ArrowRight"];
const PARTY = ["#ffd75e", "#f0a040", "#d8453b", "#ffffff", "#7fd3ff", "#ff8ad8", "#8fe07a"];
const ROLE_COLOR = { hero: "#3d7fd6", friend: "#4f8f37", villain: "#d8453b" };
const WEAPON_NAMES = { "🏹": "arrows", "💣": "bombs", "🗡️": "swords", "💧": "water", "✨": "magic", "⚡": "zaps", "❄️": "snowballs", "⭐": "stars" };
const MONSTER = { id: "_monster", name: "Monster", emoji: "👾", img: null, role: "villain", big: false, flip: false };
const NOBODY = { id: "_hero", name: "Hero", emoji: "🧒", img: null, role: "hero", big: false, flip: false };
// Phones held upright crop the 16:9 picture to 4:3, so x 120…840 is what's always visible.
const SAFE_L = 130, SAFE_R = 830;

const pageText = (p) => (p ? [p.narration || "", ...(p.lines || []).map((l) => l.text || "")].join(" ") : "");

// Sprites for the cast. If pictures can't be loaded (e.g. the store is locked), fall back to emoji.
async function getSprites(book) {
  try { return await art.loadSprites(book); } catch { /* fall through */ }
  const map = new Map();
  for (const c of book.cast || []) {
    map.set(c.id, { id: c.id, name: c.name, emoji: c.emoji || "🧒", img: null, role: c.role, big: !!c.big, flip: (c.faces === "left") !== !!c.flip });
  }
  return map;
}

// A comic panel for a page: the child's photo, else a drawn scene. Never throws.
async function getPanel(page, sprites) {
  try {
    const c = await art.renderPanel(page, sprites, W, H);
    if (c) return { canvas: c, photo: !!page.imageId };
  } catch { /* fall through */ }
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const place = PLACES[page.place] ? page.place : "forest";
  art.drawScene(x, W, H, place, place.length * 97);
  x.fillStyle = "#000";
  for (const a of art.layoutActors(page.actors || [], sprites, W, H)) art.drawSprite(x, a.s, a.x, a.y, a.size, { faceLeft: a.faceLeft });
  return { canvas: c, photo: false };
}

export async function playGame(book, { onExit, onFinish } = {}) {
  const sprites = await getSprites(book);
  const steps = planGame(book);
  const all = [...sprites.values()];
  const hero = all.find((s) => s.role === "hero") || all.find((s) => s.role !== "villain") || NOBODY;
  const bookText = (book.pages || []).map(pageText).join(" ");
  const panels = new Map();

  /* ---------------- DOM ---------------- */
  const cv = h("canvas", { class: "g-canvas", width: W, height: H, role: "img", "aria-label": book.title || "Story" });
  const ctx = cv.getContext("2d");
  const label = h("small", { class: "g-step" });
  const soundBtn = h("button", { type: "button", class: "g-chip", "aria-label": "Sounds", onclick: () => toggle("sound") });
  const readBtn = h("button", { type: "button", class: "g-chip", "aria-label": "Read to me", onclick: () => toggle("read") });
  const helpEl = h("div", { class: "g-help", hidden: true });
  const capWho = h("b", { class: "g-who" });
  const capText = h("span", { class: "g-text" });
  const caption = h("div", { class: "g-caption", "aria-live": "polite" }, capWho, capText);
  const controls = h("nav", { class: "g-controls", "aria-label": "Game buttons" });
  const overlay = h("div", { class: "g-overlay", hidden: true });
  const stage = h("main", { class: "g-stage" }, cv, helpEl, overlay);
  const root = h("div", { class: "game" },
    h("header", { class: "g-top" },
      h("button", { type: "button", class: "g-chip", "aria-label": "Back", onclick: () => exit() }, "‹", h("span", { class: "g-lbl" }, " Back")),
      h("h1", { class: "g-title" }, h("span", { class: "g-name" }, book.title || "My Story"), label),
      soundBtn, readBtn),
    h("div", { class: "g-stagewrap" }, stage),
    caption, controls);
  show(root);

  function paintToggles() {
    soundBtn.replaceChildren(settings.sound ? "🔊" : "🔇", h("span", { class: "g-lbl" }, " Sounds"));
    readBtn.replaceChildren(settings.read ? "🗣️" : "🤫", h("span", { class: "g-lbl" }, " Read to me"));
    soundBtn.setAttribute("aria-pressed", String(settings.sound));
    readBtn.setAttribute("aria-pressed", String(settings.read));
  }
  function toggle(k) {
    setSetting(k, !settings[k]);
    paintToggles();
    if (k === "sound" && settings.sound) sfx.click();
  }
  paintToggles();

  /* ---------------- lifecycle ---------------- */
  let alive = true, raf = 0, last = performance.now();
  let epoch = 0; // bumps on every step change; stale callbacks check it
  let mode = null; // { update(dt), draw(), pointer?(type, x, y) }
  let cancelTalk = () => {};
  const timers = new Set();
  const later = (fn, ms) => {
    const my = epoch;
    const id = setTimeout(() => { timers.delete(id); if (alive && my === epoch) fn(); }, ms);
    timers.add(id);
  };
  const upright = matchMedia("(orientation: portrait) and (max-width: 600px)");

  function destroy() {
    if (!alive) return;
    alive = false; epoch++;
    cancelAnimationFrame(raf);
    for (const id of timers) clearTimeout(id);
    timers.clear();
    cancelTalk(); stopSpeech();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", releaseHolds);
  }
  function exit() { destroy(); onExit?.(); }

  /* ---------------- controls tray ---------------- */
  let keyMap = new Map();
  let btns = [];
  // b: { icon, label, color, keys, keyName, fn, tap, hold, pulse }
  function setControls(list) {
    keyMap = new Map();
    releaseHolds();
    btns = list;
    controls.replaceChildren(...list.map((b) => {
      const el = h("button", { type: "button", class: `g-act ${b.color || ""}${b.pulse ? " g-pulse" : ""}` },
        h("span", { class: "g-icon", "aria-hidden": "true" }, b.icon || ""),
        h("span", { class: "g-label" }, b.label),
        b.keyName ? h("kbd", null, b.keyName) : null,
        b.charge ? h("span", { class: "g-fill" }) : null);
      if (b.hold) {
        const down = (e) => { e.preventDefault(); audio(); b.held = true; el.classList.add("pressed"); b.fn(true); };
        const up = () => { if (!b.held) return; b.held = false; el.classList.remove("pressed"); b.fn(false); };
        el.addEventListener("pointerdown", down);
        ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => el.addEventListener(ev, up));
        el.addEventListener("click", (e) => { if (e.detail === 0) { b.fn(true); setTimeout(() => b.fn(false), 250); } });
        el.addEventListener("contextmenu", (e) => e.preventDefault());
      } else if (b.tap) {
        el.addEventListener("click", () => { if (!el.disabled) { audio(); b.fn(); } });
      } else {
        // Action buttons fire on touch-down so they feel instant; keyboard clicks have detail 0.
        el.addEventListener("pointerdown", (e) => { e.preventDefault(); if (!el.disabled) { audio(); b.fn(); } });
        el.addEventListener("click", (e) => { if (e.detail === 0 && !el.disabled) b.fn(); });
      }
      b.el = el;
      for (const k of b.keys || []) keyMap.set(k.length === 1 ? k.toLowerCase() : k, b);
      return el;
    }));
    return list;
  }
  function releaseHolds() {
    for (const b of btns) if (b.hold && b.held) { b.held = false; b.el?.classList.remove("pressed"); b.fn(false); }
  }
  const keyOf = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  function onKey(e) {
    if (!alive || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector(".modal-wrap")) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    // A focused button handles its own Enter/Space (native click).
    if (t && t.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
    if (e.key === "Escape") { e.preventDefault(); exit(); return; }
    const b = keyMap.get(keyOf(e));
    if (!b || !b.el || b.el.disabled) return;
    e.preventDefault();
    if (e.repeat) return;
    audio();
    if (b.hold) { if (!b.held) { b.held = true; b.el.classList.add("pressed"); b.fn(true); } return; }
    b.fn();
    b.el.classList.add("pressed");
    setTimeout(() => b.el.classList.remove("pressed"), 120);
  }
  function onKeyUp(e) {
    const b = keyMap.get(keyOf(e));
    if (b && b.hold && b.held) { b.held = false; b.el.classList.remove("pressed"); b.fn(false); }
  }
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseHolds);

  // Canvas pointer (drag/tap to move in the treasure hunt), in 960×540 picture coordinates.
  function toCanvas(e) {
    const r = cv.getBoundingClientRect();
    const fit = getComputedStyle(cv).objectFit;
    const sc = fit === "cover" ? Math.max(r.width / W, r.height / H) : Math.min(r.width / W, r.height / H);
    return { x: (e.clientX - r.left - (r.width - W * sc) / 2) / sc, y: (e.clientY - r.top - (r.height - H * sc) / 2) / sc };
  }
  let dragging = false;
  cv.addEventListener("pointerdown", (e) => { if (!mode?.pointer) return; dragging = true; cv.setPointerCapture?.(e.pointerId); const p = toCanvas(e); mode.pointer("down", p.x, p.y); });
  cv.addEventListener("pointermove", (e) => { if (!dragging || !mode?.pointer) return; const p = toCanvas(e); mode.pointer("move", p.x, p.y); });
  const endDrag = () => { if (dragging) { dragging = false; mode?.pointer?.("up", 0, 0); } };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  /* ---------------- captions, help, overlay ---------------- */
  function setLabel(text) { label.textContent = text; cv.setAttribute("aria-label", text); }
  function setCaption(who, text, color) {
    capWho.textContent = who || "";
    capWho.style.color = color || "";
    capText.textContent = text || "";
    caption.classList.toggle("quiet", !who);
  }
  function help(text) {
    setCaption("", text);
    helpEl.textContent = text; helpEl.hidden = false;
    later(() => { helpEl.hidden = true; }, 7000);
    say(text);
  }
  function setOverlay(nodes) {
    if (!nodes) { overlay.hidden = true; overlay.replaceChildren(); root.classList.remove("g-over"); return; }
    overlay.replaceChildren(...nodes.filter(Boolean));
    overlay.hidden = false;
    root.classList.add("g-over");
  }

  /* ---------------- effects ---------------- */
  let parts = [], texts = [], shake = 0;
  function burst(x, y, n, colors, speed = 300, size = 6, life = 0.8, grav = 600) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life, max: life, c: colors[i % colors.length], s: size * (0.6 + Math.random() * 0.8), g: grav });
    }
  }
  function sparkle(x, y, n = 6, emoji = "✨") {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 160;
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, life: 1.2, max: 1.2, e: emoji, s: 30 + Math.random() * 20, g: 120 });
    }
  }
  function addText(t, x, y, c = "#fff", size = 40, life = 1.2, rise = 30) { texts.push({ t, x, y, c, size, life, max: life, rise }); }
  function updFx(dt) {
    for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; p.life -= dt; }
    parts = parts.filter((p) => p.life > 0);
    for (const t of texts) { t.y -= t.rise * dt; t.life -= dt; }
    texts = texts.filter((t) => t.life > 0);
    shake = Math.max(0, shake - 40 * dt);
  }
  function drawFx() {
    for (const p of parts) {
      const a = Math.max(0, p.life / p.max);
      if (p.e) { emo(p.e, p.x, p.y, p.s, a); continue; }
      ctx.globalAlpha = a; ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const t of texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      outlined(t.t, t.x, t.y, t.size, t.c, "center");
    }
    ctx.globalAlpha = 1;
  }
  function outlined(text, x, y, size, color = "#fff", align = "left") {
    ctx.font = `bold ${size}px ${DISPLAY}`;
    ctx.textAlign = align; ctx.textBaseline = "alphabetic"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(4, size / 7); ctx.strokeStyle = INK; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }
  // Colour emoji take the alpha of the current fillStyle in some browsers, so reset it first.
  const sprite = (s, x, y, size, o) => { ctx.fillStyle = "#000"; art.drawSprite(ctx, s, x, y, size, o); };
  const emo = (e, x, y, size, alpha = 1) => { ctx.fillStyle = "#000"; art.drawEmoji(ctx, e, x, y, size, alpha); };
  // Backgrounds come from art.js; isolate them so no canvas state (alpha, fonts) leaks into ours.
  function scene(place, scroll, t) { ctx.save(); art.drawScene(ctx, W, H, place, scroll, t); ctx.restore(); ctx.globalAlpha = 1; }
  function emojiAt(e, x, y, size, rot = 0, alpha = 1) {
    if (!rot) { emo(e, x, y, size, alpha); return; }
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); emo(e, 0, 0, size, alpha); ctx.restore();
  }

  /* ---------------- text layout for bubbles ---------------- */
  function wrap(text, maxW) {
    const out = [];
    let line = "";
    for (let w of String(text).split(/\s+/).filter(Boolean)) {
      while (ctx.measureText(w).width > maxW && w.length > 1) { // a very long word: break it
        let cut = w.length - 1;
        while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxW) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    if (line) out.push(line);
    return out;
  }
  function fit(text, maxW, maxH, big = 30, small = 16) {
    let size = big, lines = [];
    for (; size >= small; size -= 2) {
      ctx.font = `bold ${size}px ${DISPLAY}`;
      lines = wrap(text, maxW);
      if (lines.length * size * 1.25 <= maxH) break;
    }
    size = Math.max(size, small);
    ctx.font = `bold ${size}px ${DISPLAY}`;
    const max = Math.max(1, Math.floor(maxH / (size * 1.25)));
    if (lines.length > max) { lines = lines.slice(0, max); lines[max - 1] = lines[max - 1].replace(/\s*\S*$/, "") + "…"; }
    const width = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    return { size, lines, lh: size * 1.25, width };
  }

  /* ---------------- step flow ---------------- */
  let stepIndex = -1, stars = 0, finished = false;
  function resetStep() {
    epoch++;
    cancelTalk(); cancelTalk = () => {};
    stopSpeech();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    parts = []; texts = []; shake = 0;
    helpEl.hidden = true;
    setOverlay(null);
    root.classList.remove("g-story");
    mode = null;
  }
  function goStep(i) {
    resetStep();
    stepIndex = i;
    const st = steps[i];
    if (!st) return showEnd();
    if (st.type === "story") startStory(st);
    else startLevel(st);
  }
  function next() { sfx.click(); goStep(stepIndex + 1); }

  /* ---------------- story pages ---------------- */
  async function panelFor(i) {
    if (!panels.has(i)) panels.set(i, getPanel(book.pages[i], sprites));
    return panels.get(i);
  }
  async function startStory(st) {
    const my = epoch;
    const page = book.pages[st.page];
    setLabel(`📖 Page ${st.page + 1} of ${book.pages.length}`);
    root.classList.add("g-story"); // upright phones show the whole panel, not a crop
    setCaption("", "📖 …");
    setControls([]);
    const panel = await panelFor(st.page);
    if (!alive || my !== epoch) return;
    const lines = [];
    if (page.narration) lines.push({ who: null, name: "", role: "narrator", text: page.narration });
    for (const l of page.lines || []) {
      const c = sprites.get(l.who);
      lines.push({ who: l.who, name: c?.name || "", role: c?.role || "friend", text: l.text || "" });
    }
    const pos = new Map();
    if (!panel.photo) for (const a of art.layoutActors(page.actors || [], sprites, W, H)) pos.set(a.s.id, a);
    const s = { t: 0, lines, cur: -1, done: false, panel, pos, page, narr: page.narration || "" };
    mode = { update: (dt) => { s.t += dt; }, draw: () => drawStory(s) };
    s.btns = setControls([
      { icon: "🔁", label: "Again", color: "gray", tap: true, keys: ["r"], keyName: "R", fn: () => { sfx.click(); readFrom(s, 0); } },
      { icon: "▶", label: "Next", color: "green", tap: true, keys: NEXT_KEYS, keyName: "space", fn: next },
    ]);
    readFrom(s, 0);
    // Pre-render the next page's panel while this one is read.
    const nx = steps.slice(stepIndex + 1).find((x) => x.type === "story");
    if (nx) panelFor(nx.page);
  }
  function readFrom(s, i) {
    cancelTalk();
    const my = epoch;
    s.btns?.[1]?.el?.classList.toggle("g-pulse", i >= s.lines.length);
    if (i >= s.lines.length) {
      s.done = true;
      if (!s.lines.length) setCaption("", `📖 Page ${s.page ? book.pages.indexOf(s.page) + 1 : ""}`);
      return;
    }
    s.cur = i;
    const l = s.lines[i];
    setCaption(l.name, l.text, ROLE_COLOR[l.role]);
    cancelTalk = talk({ role: l.role, text: l.text }, () => { if (my === epoch) later(() => readFrom(s, i + 1), 350); });
  }
  function drawStory(s) {
    ctx.drawImage(s.panel.canvas, 0, 0, W, H);
    const up = upright.matches;
    const l = s.lines[s.cur];
    let top = 14;
    if (s.narr && !up) top = drawNarration(s.narr) + 10;
    if (!l || l.role === "narrator") return;
    const a = s.pos.get(l.who);
    if (up) { if (a) drawMarker(a, s.t); return; }
    if (a) drawBubble(l, a, top);
    else drawStrip(l);
  }
  function drawNarration(text) {
    const f = fit(text, 860, 132, 28, 16);
    const bw = f.width + 36, bh = f.lines.length * f.lh + 22, bx = 16, by = 14;
    ctx.fillStyle = "#fff6c9"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    f.lines.forEach((ln, i) => ctx.fillText(ln, bx + 18, by + 11 + f.lh * (i + 0.5)));
    ctx.textBaseline = "alphabetic";
    return by + bh;
  }
  function drawBubble(l, a, top) {
    const headY = a.y - a.size * 0.95;
    const room = Math.max(90, Math.min(220, headY - top - 26));
    const f = fit(l.text, 400, room - 34, 28, 16);
    const nameH = 26;
    const bw = Math.max(f.width, measureName(l.name)) + 40, bh = f.lines.length * f.lh + nameH + 18;
    const bx = Math.max(16, Math.min(W - bw - 16, a.x - bw / 2));
    const by = Math.max(top, Math.min(H - bh - 70, headY - bh - 26));
    const tipX = Math.max(bx + 26, Math.min(bx + bw - 26, a.x)), tipY = Math.max(by + bh + 10, headY);
    ctx.fillStyle = "#fff"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 22); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tipX - 14, by + bh - 2); ctx.lineTo(tipX + (a.x > tipX ? 10 : -4), tipY); ctx.lineTo(tipX + 14, by + bh - 2); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(tipX - 12, by + bh - 7, 24, 6);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `bold 20px ${DISPLAY}`; ctx.fillStyle = ROLE_COLOR[l.role] || INK;
    ctx.fillText(l.name.toUpperCase(), bx + bw / 2, by + 8 + nameH / 2);
    ctx.font = `bold ${f.size}px ${DISPLAY}`; ctx.fillStyle = INK;
    f.lines.forEach((ln, i) => ctx.fillText(ln, bx + bw / 2, by + 8 + nameH + f.lh * (i + 0.5)));
    ctx.textBaseline = "alphabetic";
  }
  function measureName(name) { ctx.font = `bold 20px ${DISPLAY}`; return ctx.measureText(String(name).toUpperCase()).width; }
  // A speaker we can't point at (a photo page): a speech strip along the bottom.
  function drawStrip(l) {
    const f = fit(`${l.name ? l.name + ": " : ""}${l.text}`, 860, 120, 28, 16);
    const bw = f.width + 40, bh = f.lines.length * f.lh + 20, bx = (W - bw) / 2, by = H - bh - 14;
    ctx.fillStyle = "#fff"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    f.lines.forEach((ln, i) => ctx.fillText(ln, W / 2, by + 10 + f.lh * (i + 0.5)));
    ctx.textBaseline = "alphabetic";
  }
  // Upright phones put the words in the caption below; on the picture a bouncing arrow shows who's talking.
  function drawMarker(a, t) {
    const x = Math.max(40, Math.min(W - 40, a.x));
    const y = Math.max(60, a.y - a.size * 0.95 - 16 - Math.abs(Math.sin(t * 6)) * 14);
    ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.fillStyle = "#ffd75e"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(x - 30, y - 40); ctx.lineTo(x + 30, y - 40); ctx.lineTo(x, y); ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  /* ---------------- levels ---------------- */
  function levelWon(s, msg, { keep = false } = {}) {
    if (s.won) return;
    s.won = true; stars++;
    sfx.fanfare();
    ctx.font = `bold 64px ${DISPLAY}`;
    const size = Math.min(64, Math.floor(64 * 660 / Math.max(1, ctx.measureText(msg).width)));
    addText(msg, W / 2, 190, "#f0a040", size, 99, 0);
    setCaption("", msg + " ⭐");
    helpEl.hidden = true;
    say(msg);
    later(() => {
      const nextBtn = { icon: "⭐", label: "Hooray! Next", color: "green", pulse: true, tap: true, keys: NEXT_KEYS, keyName: "space", fn: next };
      s.btns = setControls(keep ? [...s.btns.map((b) => ({ ...b, el: null, held: false, keys: (b.keys || []).filter((k) => !NEXT_KEYS.includes(k)) })), nextBtn] : [nextBtn]);
    }, 900);
  }
  function friendsOf(page) {
    const ids = [...(page?.actors || []), ...all.map((s) => s.id)];
    const out = [];
    for (const id of ids) {
      const s = sprites.get(id);
      if (s && s.role !== "villain" && s !== hero && !out.includes(s)) out.push(s);
    }
    return out;
  }
  function villainOf(page) {
    for (const id of page?.actors || []) { const s = sprites.get(id); if (s && s.role === "villain") return s; }
    return all.find((s) => s.role === "villain") || MONSTER;
  }
  const weaponOf = (page) => pickByWords(pageText(page), WEAPONS, null) || pickByWords(bookText, WEAPONS, "⭐");
  const itemOf = (page) => pickByWords(pageText(page), ITEMS, null) || pickByWords(bookText, ITEMS, "⭐");
  function progressBar(p, fromS, toEmoji) {
    const x0 = 250, x1 = 690, y = 40;
    ctx.fillStyle = "rgba(251,244,226,.92)"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(x0 - 12, y - 15, x1 - x0 + 24, 30, 15); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#5f9e45"; ctx.beginPath(); ctx.roundRect(x0 - 8, y - 11, (x1 - x0 + 16) * Math.min(1, p), 22, 11); ctx.fill();
    emo(toEmoji, x1 + 44, y, 40);
    sprite(fromS, x0 + (x1 - x0) * Math.min(1, p), y + 20, 40);
  }
  function hpBar(x, y, hp, max, name) {
    const w = 220;
    x = Math.max(SAFE_L + w / 2, Math.min(SAFE_R - w / 2, x));
    outlined(name, x, y - 22, 22, "#fff", "center");
    ctx.fillStyle = "#fff"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - 14, w, 22, 11); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#d8453b"; ctx.beginPath(); ctx.roundRect(x - w / 2 + 3, y - 11, (w - 6) * Math.max(0, hp / max), 16, 8); ctx.fill();
  }

  const LEVELS = {
    journey: {
      help: (s) => `Press JUMP to hop over things on the way. Grab the ${s.itemName}!`,
      init(s) {
        Object.assign(s, { dist: 0, goal: 6000, speed: 280, my: 0, vy: 0, jumps: 0, stun: 0, obs: [], items: [], nextObs: 1.5, nextItem: 0.8, goalX: null, got: 0, hist: [],
          side: friendsOf(s.page)[0] || null, item: itemOf(s.page), P: PLACES[s.place] });
        s.itemName = s.item === "⭐" ? "stars" : "treats";
      },
      controls: (s) => [{ icon: "⬆️", label: "JUMP", color: "orange", keys: [" ", "Enter", "ArrowUp", "j"], keyName: "space", fn: () => {
        if (s.won || s.jumps >= 2) return;
        s.vy = s.jumps ? -640 : -780; s.jumps++; sfx.jump();
      } }],
      update(s, dt) {
        const sp = s.won ? 0 : s.stun > 0 ? 120 : s.speed;
        s.dist += sp * dt; s.stun -= dt;
        s.vy += 2000 * dt; s.my += s.vy * dt;
        if (s.my > 0) { s.my = 0; s.vy = 0; s.jumps = 0; }
        s.hist.push(s.my); if (s.hist.length > 14) s.hist.shift();
        const left = s.goal - s.dist;
        if (left > 1300) {
          if ((s.nextObs -= dt) <= 0) {
            s.obs.push({ e: s.P.obstacles[Math.floor(Math.random() * s.P.obstacles.length)], x: W + 50, hit: false, dy: 0, vy: 0, rot: 0 });
            s.nextObs = 1.5 + Math.random() * 1.1;
          }
          if ((s.nextItem -= dt) <= 0) {
            s.items.push({ x: W + 50, y: Math.random() < 0.5 ? G - 60 : G - 190 });
            s.nextItem = 0.9 + Math.random() * 0.8;
          }
        }
        const hx = 220, feet = G + s.my;
        for (const o of s.obs) {
          o.x -= sp * dt;
          if (o.hit) { o.vy += 1500 * dt; o.dy += o.vy * dt; o.rot += 6 * dt; o.x += 200 * dt; continue; }
          if (Math.abs(o.x - hx) < 46 && feet > G - 46) {
            o.hit = true; o.vy = -500; s.stun = 0.7; sfx.bonk(); addText("Oops!", hx, G - 160, "#fff", 38);
          }
        }
        s.obs = s.obs.filter((o) => o.x > -100 && o.dy < 400);
        for (const it of s.items) {
          it.x -= sp * dt;
          if (!it.got && Math.hypot(it.x - hx, it.y - (feet - 60)) < 62) {
            it.got = true; s.got++; sfx.coin(); burst(it.x, it.y, 10, ["#ffd75e", "#fff"], 200, 4, 0.5);
          }
        }
        s.items = s.items.filter((it) => !it.got && it.x > -60);
        if (left < 1000) s.goalX = 290 + left;
        if (s.goalX !== null && s.goalX <= 330 && !s.won) {
          sparkle(s.goalX, G - 120, 10);
          levelWon(s, "We made it!");
        }
      },
      draw(s) {
        scene(s.place, s.dist, s.t);
        if (s.goalX !== null) emo(s.P.goal, s.goalX + 40, G - 90, 190);
        for (const it of s.items) emo(s.item, it.x, it.y + Math.sin(s.t * 4 + it.x * 0.02) * 5, 48);
        for (const o of s.obs) emojiAt(o.e, o.x, G - 28 + o.dy, 64, o.rot);
        const running = s.my === 0 && !s.won;
        if (s.side) {
          const sy = s.hist[0] || 0;
          sprite(s.side, 110, G + 4 + sy - (sy === 0 && running ? Math.abs(Math.sin(s.t * 12 + 1)) * 6 : 0), 96);
        }
        const bob = running ? Math.abs(Math.sin(s.t * 12)) * 7 : 0;
        sprite(hero, 220, G + 4 + s.my - bob, 120, { rot: s.stun > 0 ? Math.sin(s.t * 30) * 0.15 : 0 });
        progressBar(s.dist / s.goal, hero, s.P.goal);
        outlined(`${s.got}`, SAFE_L + 56, 108, 34, "#ffd75e");
        emo(s.item, SAFE_L + 24, 96, 36);
      },
    },

    battle: {
      help: (s) => `Press ATTACK to throw ${WEAPON_NAMES[s.weapon] || "magic"} at the ${s.V.name}! When SUPER is ready, press it for a big blast!`,
      init(s) {
        const V = villainOf(s.page);
        const big = !!V.big;
        Object.assign(s, { V, big, size: big ? 260 : 170, max: big ? 36 : 24, hurt: 0, cool: 0, charge: 0.5, shots: [], supers: [], dead: false, flop: 0,
          rx: W + 120, roar: 0, nextRoar: 2.5, my: 0, vy: 0, turn: 0, side: friendsOf(s.page)[0] || null, weapon: weaponOf(s.page) });
        s.hp = s.max;
      },
      controls: (s) => [
        { icon: s.weapon, label: "ATTACK", color: "blue", keys: [" ", "Enter", "a"], keyName: "space", fn: () => {
          if (s.dead || s.cool > 0) return;
          s.cool = 0.22; sfx.shoot();
          const fromSide = s.side && s.turn++ % 2 === 1;
          const bx = fromSide ? 330 : 240, by = G - (fromSide ? 70 : 80), tx = s.rx - 20, ty = G - s.size * 0.5;
          const d = Math.hypot(tx - bx, ty - by) || 1;
          s.shots.push({ x: bx, y: by, vx: (tx - bx) / d * 950, vy: (ty - by) / d * 950, rot: 0 });
        } },
        { icon: "💥", label: "SUPER", color: "red", charge: true, keys: ["s", "b"], keyName: "S", fn: () => {
          if (s.dead || s.charge < 1) return;
          s.charge = 0; sfx.whistle();
          const T = 0.95, x0 = 240, y0 = G - 90, x1 = s.rx - 20, y1 = G - s.size * 0.5, g = 1200;
          s.supers.push({ x: x0, y: y0, vx: (x1 - x0) / T, vy: (y1 - y0 - 0.5 * g * T * T) / T, life: T, g, rot: 0 });
        } },
      ],
      update(s, dt) {
        s.cool -= dt; s.hurt -= dt; s.roar -= dt;
        s.charge = Math.min(1, s.charge + dt / 2.2);
        const sup = s.btns?.[1];
        if (sup?.el) {
          const ready = s.charge >= 1 && !s.dead;
          sup.el.disabled = !ready && !s.won;
          sup.el.classList.toggle("g-pulse", ready);
          const fill = sup.el.querySelector(".g-fill");
          if (fill) fill.style.width = `${Math.round(s.charge * 100)}%`;
        }
        s.vy += 2000 * dt; s.my += s.vy * dt; if (s.my > 0) { s.my = 0; s.vy = 0; }
        if (!s.dead) {
          if (s.big) {
            const home = 720 + Math.sin(s.t * 0.9) * 30;
            s.rx = s.rx > home + 5 ? s.rx - 260 * dt : home;
            if ((s.nextRoar -= dt) <= 0) { s.nextRoar = 5 + Math.random() * 2; s.roar = 1; sfx.roar(); shake = 12; addText("ROAR!", Math.min(SAFE_R - 80, s.rx), 130, "#f0a040", 64, 1.2); }
          } else {
            s.rx -= (s.rx > W ? 260 : 50) * dt;
            if (s.rx < 430) { s.rx += 220; s.vy = -600; sfx.squeak(); addText("Eek!", 220, G - 170, "#fff", 40); }
          }
        } else {
          s.flop = Math.min(1, s.flop + dt * 1.6);
          if (Math.random() < dt * 6) sparkle(s.rx + (Math.random() - 0.3) * s.size, G - s.size * 0.4 * Math.random(), 1, Math.random() < 0.5 ? "✨" : "⭐");
        }
        const hit = (dmg) => {
          s.hp -= dmg; s.hurt = 0.18;
          if (!s.big) s.rx = Math.min(880, s.rx + 26);
          if (s.hp <= 0 && !s.dead) {
            s.dead = true; s.hp = 0; shake = s.big ? 26 : 14;
            if (s.big) sfx.bigboom(); else sfx.boom();
            burst(s.rx, G - s.size * 0.5, 70, PARTY, 520, 8, 1.3);
            sparkle(s.rx, G - s.size * 0.6, 10);
            addText(s.big ? "BOOM!" : "POW!", W / 2, 280, "#ffd75e", 100, 2);
            later(() => levelWon(s, "Hooray! You won!"), 1500);
          }
        };
        for (const a of s.shots) {
          a.x += a.vx * dt; a.y += a.vy * dt; a.rot += dt * 12;
          if (!a.done && !s.dead && a.x > s.rx - s.size * 0.3) {
            a.done = true; sfx.hit(); burst(a.x, a.y, 8, ["#fff", "#f0a040"], 220, 4, 0.4);
            addText(["Pow!", "Zap!", "Bam!", "Boink!"][Math.floor(Math.random() * 4)], a.x, a.y - 30, "#ffd75e", 34, 0.8);
            hit(1);
          }
        }
        s.shots = s.shots.filter((a) => !a.done && a.x < W + 60);
        for (const b of s.supers) {
          b.x += b.vx * dt; b.y += b.vy * dt; b.vy += b.g * dt; b.life -= dt; b.rot += dt * 8;
          if (b.life <= 0 && !b.done) {
            b.done = true; sfx.boom(); shake = 18;
            burst(b.x, b.y, 40, PARTY, 450, 8, 0.9);
            addText("BOOM!", b.x, b.y - 60, "#ffd75e", 70, 1);
            if (!s.dead) hit(6);
          }
        }
        s.supers = s.supers.filter((b) => !b.done);
      },
      draw(s) {
        scene(s.place, 0, s.t);
        // The villain flops over backwards when beaten.
        if (s.dead) {
          const th = s.flop * Math.PI, half = s.size / 2;
          const cx = s.rx + (Math.min(s.rx, SAFE_R - half) - s.rx) * s.flop;
          const cy = G + 4 - half - Math.sin(s.flop * Math.PI) * 70;
          sprite(s.V, cx - half * Math.sin(th), cy + half * Math.cos(th), s.size, { faceLeft: true, rot: th });
        } else {
          sprite(s.V, s.rx, G + 4 + Math.sin(s.t * 6) * 2, s.size, { faceLeft: true, rot: s.roar > 0 ? -0.08 : 0, alpha: s.hurt > 0 ? 0.7 : 1 });
        }
        if (s.side) sprite(s.side, 330, G + 4 - Math.abs(Math.sin(s.t * 3)) * 6, 100);
        sprite(hero, 220, G + 4 + s.my, 120);
        for (const a of s.shots) emojiAt(s.weapon, a.x, a.y, 52, a.rot);
        for (const b of s.supers) emojiAt(s.weapon, b.x, b.y, 110, b.rot);
        if (!s.dead) hpBar(s.rx, G + 58, s.hp, s.max, s.V.name);
      },
    },

    collect: {
      help: (s) => `Move with the arrow buttons, or drag your finger, to catch ${s.goalN} falling ${s.item === "⭐" ? "stars" : "treasures"}!`,
      init(s) {
        Object.assign(s, { x: 480, dir: 0, target: null, items: [], next: 0.4, got: 0, goalN: 10, face: false, sx: 360, side: friendsOf(s.page)[0] || null, item: itemOf(s.page) });
      },
      controls: (s) => [
        { icon: "◀", label: "Left", color: "blue", hold: true, keys: ["ArrowLeft", "a"], keyName: "←", fn: (on) => { if (on) { s.dir = -1; s.target = null; } else if (s.dir === -1) s.dir = 0; } },
        { icon: "▶", label: "Right", color: "blue", hold: true, keys: ["ArrowRight", "d"], keyName: "→", fn: (on) => { if (on) { s.dir = 1; s.target = null; } else if (s.dir === 1) s.dir = 0; } },
      ],
      pointer(s, type, x) { if (type !== "up") s.target = x; },
      update(s, dt) {
        const old = s.x;
        if (s.dir) s.x += s.dir * 480 * dt;
        else if (s.target !== null) { const d = s.target - s.x; s.x += Math.sign(d) * Math.min(Math.abs(d), 620 * dt); }
        s.x = Math.max(SAFE_L + 30, Math.min(SAFE_R - 30, s.x));
        if (Math.abs(s.x - old) > 0.5) s.face = s.x < old;
        s.moving = Math.abs(s.x - old) > 0.5;
        s.sx += (s.x + (s.face ? 120 : -120) - s.sx) * Math.min(1, dt * 2.5);
        if (!s.won && (s.next -= dt) <= 0) {
          s.next = 0.75 + Math.random() * 0.5;
          const near = Math.random() < 0.55;
          const x = near ? s.x + (Math.random() - 0.5) * 360 : SAFE_L + 40 + Math.random() * (SAFE_R - SAFE_L - 80);
          s.items.push({ x: Math.max(SAFE_L + 30, Math.min(SAFE_R - 30, x)), y: -30, vy: 150 + Math.random() * 70, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 4 });
        }
        for (const it of s.items) {
          it.y += it.vy * dt; it.rot += it.spin * dt;
          if (!it.done && !s.won && it.y > G - 150 && it.y < G - 20 && Math.abs(it.x - s.x) < 72) {
            it.done = true; s.got++; sfx.coin(); burst(it.x, it.y, 10, ["#ffd75e", "#fff"], 220, 4, 0.5); addText("+1", it.x, it.y - 30, "#ffd75e", 34, 0.7);
            if (s.got >= s.goalN) { sparkle(s.x, G - 120, 12); levelWon(s, "You found them all!"); }
          }
          if (!it.done && it.y > G + 10) { it.done = true; burst(it.x, G + 10, 6, ["#fff"], 120, 3, 0.3); }
        }
        s.items = s.items.filter((it) => !it.done);
      },
      draw(s) {
        scene(s.place, 0, s.t);
        for (const it of s.items) emojiAt(s.item, it.x, it.y, 56, it.rot);
        if (s.side) sprite(s.side, s.sx, G + 4 - Math.abs(Math.sin(s.t * 5)) * 8, 92, { faceLeft: s.face });
        sprite(hero, s.x, G + 4 - (s.moving ? Math.abs(Math.sin(s.t * 14)) * 6 : 0), 124, { faceLeft: s.face });
        emo(s.item, SAFE_L + 24, 52, 40);
        outlined(`${s.got} / ${s.goalN}`, SAFE_L + 54, 66, 36, "#ffd75e");
      },
    },

    climb: {
      help: () => "Press CLIMB to go up the ladder, step by step!",
      init(s) {
        const P = PLACES[s.place];
        Object.assign(s, { rung: 0, total: 10, y: G, ty: G, hx: 480, top: 196, goal: P?.goal || "🏠", side: friendsOf(s.page)[0] || null, cheer: 0 });
        s.step = (G - s.top) / s.total;
      },
      controls: (s) => [{ icon: "🪜", label: "CLIMB", color: "green", keys: [" ", "Enter", "ArrowUp", "c"], keyName: "space", fn: () => {
        if (s.won || s.rung >= s.total) return;
        sfx.note(s.rung); s.rung++; s.ty = G - s.rung * s.step; s.cheer = 0.5;
        addText(String(s.rung), 560, s.ty - 70, "#ffd75e", 40, 0.8);
        if (s.rung >= s.total) later(() => { s.hx = 570; burst(640, 150, 70, PARTY, 500, 7, 1.5); sparkle(620, 140, 10); levelWon(s, "We made it to the top!"); }, 400);
      } }],
      update(s, dt) {
        s.y += (s.ty - s.y) * Math.min(1, dt * 10);
        s.cheer -= dt;
        s.cx = (s.cx ?? 480) + (s.hx - (s.cx ?? 480)) * Math.min(1, dt * 4);
      },
      draw(s) {
        scene(s.place, 0, s.t);
        // The goal sits on a ledge at the top of the ladder.
        ctx.fillStyle = "#a0703f"; ctx.strokeStyle = INK; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.roundRect(420, s.top, 360, 22, 8); ctx.fill(); ctx.stroke();
        emo(s.goal, 705, s.top - 66, 140);
        ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 8; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(445, G + 6); ctx.lineTo(445, s.top); ctx.moveTo(515, G + 6); ctx.lineTo(515, s.top); ctx.stroke();
        ctx.lineWidth = 6;
        for (let i = 0; i <= s.total; i++) { const ry = G - i * s.step; ctx.beginPath(); ctx.moveTo(445, ry); ctx.lineTo(515, ry); ctx.stroke(); }
        ctx.lineCap = "butt";
        if (s.side) sprite(s.side, 300, G + 4 - (s.cheer > 0 ? Math.sin(s.cheer * Math.PI * 2) * 20 : 0), 100);
        const climbing = Math.abs(s.ty - s.y) > 2;
        sprite(hero, s.won ? s.cx : 480, s.y + 4, 100, { rot: climbing ? Math.sin(s.t * 20) * 0.08 : 0 });
        outlined(`🪜 ${s.rung} / ${s.total}`, SAFE_L + 10, 66, 34, "#fff");
      },
    },

    friends: {
      help: () => "Press every friend's button to play together!",
      init(s) {
        let list = friendsOf(s.page).slice(0, 4);
        if (!list.length) list = [hero];
        Object.assign(s, { list, done: new Set(), runs: [], dance: 0 });
      },
      controls: (s) => s.list.map((f, i) => ({
        icon: f.emoji, label: f.name, color: ["orange", "blue", "green", "red"][i % 4], keys: [String(i + 1)], keyName: String(i + 1), fn: () => {
          if (s.runs.some((r) => r.f === f)) return;
          s.runs.push({ f, x: -120, i });
          [sfx.zoom, sfx.chirp, sfx.hehe, sfx.boing][i % 4]();
          addText(`${f.name}!`, W / 2, 140, "#ffd75e", 52, 1.4);
          s.dance = 1.6;
          if (!s.done.has(f)) { s.done.add(f); if (s.done.size === s.list.length) later(() => levelWon(s, "You played with everyone!", { keep: true }), 700); }
        },
      })),
      update(s, dt) {
        s.dance -= dt;
        for (const r of s.runs) {
          r.x += 420 * dt;
          if (Math.random() < dt * 4) parts.push({ x: r.x - 50, y: G - 10, vx: -60, vy: -40, life: 0.5, max: 0.5, c: "#fff8", s: 8, g: 0 });
        }
        s.runs = s.runs.filter((r) => r.x < W + 150);
      },
      draw(s) {
        scene(s.place, s.t * 20, s.t);
        const jump = s.dance > 0 ? Math.abs(Math.sin(s.t * 10)) * 30 : 0;
        if (hero !== s.list[0] || !s.runs.length) sprite(hero, 480, G + 4 - jump, 130, { faceLeft: s.dance > 0 && Math.sin(s.t * 5) > 0 });
        for (const r of s.runs) sprite(r.f, r.x, G + 34 - Math.abs(Math.sin(r.x / 45)) * 40, 140);
        s.list.forEach((f, i) => {
          const x = W / 2 + (i - (s.list.length - 1) / 2) * 70;
          emo("⭐", x, 52, 46, s.done.has(f) ? 1 : 0.28);
        });
      },
    },

    celebrate: {
      help: () => "Press FIREWORKS to light up the sky! Make 8 big bangs!",
      init(s) {
        const dancers = all.filter((x) => x.role !== "villain").slice(0, 5);
        Object.assign(s, { rockets: [], booms: 0, launched: 0, goalN: 8, cool: 0, dancers: dancers.length ? dancers : [hero] });
      },
      controls: (s) => [{ icon: "🎆", label: "FIREWORKS", color: "purple", keys: [" ", "Enter", "f"], keyName: "space", fn: () => {
        if (s.cool > 0 || s.launched >= s.goalN + 4) return;
        s.cool = 0.25; s.launched++; sfx.whistle();
        const x = SAFE_L + 60 + Math.random() * (SAFE_R - SAFE_L - 120);
        s.rockets.push({ x, y: G - 10, vx: (Math.random() - 0.5) * 80, vy: -720, ty: 90 + Math.random() * 140, c: PARTY[Math.floor(Math.random() * PARTY.length)] });
      } }],
      update(s, dt) {
        s.cool -= dt;
        for (const r of s.rockets) {
          r.x += r.vx * dt; r.y += r.vy * dt;
          if (Math.random() < 0.8) parts.push({ x: r.x, y: r.y + 10, vx: (Math.random() - 0.5) * 30, vy: 60, life: 0.4, max: 0.4, c: "#ffd75e", s: 3, g: 0 });
          if (!r.done && r.y <= r.ty) {
            r.done = true; s.booms++; sfx.crackle();
            burst(r.x, r.y, 70, [r.c, "#fff", PARTY[(s.booms * 3) % PARTY.length]], 380, 5, 1.4, 160);
            if (s.booms === s.goalN) later(() => levelWon(s, "What a party!", { keep: true }), 700);
          }
        }
        s.rockets = s.rockets.filter((r) => !r.done);
      },
      draw(s) {
        scene(s.place, 0, s.t);
        ctx.fillStyle = "rgba(14,12,48,.55)"; ctx.fillRect(0, 0, W, H);
        for (const r of s.rockets) emo("🚀", r.x, r.y, 30);
        const n = s.dancers.length;
        s.dancers.forEach((d, i) => {
          const x = W / 2 + (i - (n - 1) / 2) * Math.min(150, (SAFE_R - SAFE_L - 80) / Math.max(1, n - 1 || 1));
          const hop = Math.abs(Math.sin(s.t * 6 + i * 1.3)) * 26;
          sprite(d, x, G + 4 - hop, 110, { faceLeft: Math.sin(s.t * 3 + i) > 0, rot: Math.sin(s.t * 6 + i) * 0.12 });
        });
        outlined(`🎆 ${Math.min(s.booms, s.goalN)} / ${s.goalN}`, SAFE_L + 10, 66, 34, "#ffd75e");
      },
    },
  };

  function startLevel(st) {
    const kind = LEVELS[st.kind] ? st.kind : "journey";
    const L = LEVELS[kind];
    const page = book.pages[st.page] || book.pages[0];
    const s = { kind, t: 0, won: false, page, place: PLACES[page?.place] ? page.place : "forest" };
    L.init(s);
    const n = steps.slice(0, stepIndex + 1).filter((x) => x.type === "level").length;
    setLabel(`${ACTIONS[kind]?.icon || "⭐"} Level ${n}: ${ACTIONS[kind]?.label || kind}`);
    s.btns = setControls(L.controls(s));
    mode = {
      update: (dt) => { s.t += dt; L.update(s, dt); },
      draw: () => L.draw(s),
      pointer: L.pointer ? (type, x, y) => L.pointer(s, type, x, y) : null,
    };
    help(L.help(s));
  }

  /* ---------------- title and ending ---------------- */
  const castRow = () => h("p", { class: "g-castrow", "aria-hidden": "true" }, all.slice(0, 6).map((s) => s.emoji).join(" "));
  function showTitle() {
    resetStep();
    stepIndex = -1;
    setLabel("Ready to play?");
    setOverlay([
      castRow(),
      h("h2", { class: "g-big" }, book.title || "My Story"),
      book.author ? h("p", { class: "g-sub" }, "by ", h("strong", null, book.author)) : null,
      h("p", { class: "g-sub g-muted" }, `${book.pages.length} pages · ${steps.filter((x) => x.type === "level").length} games`),
    ]);
    setCaption("", "Press Play to start the story!");
    setControls([{ icon: "▶", label: "Play!", color: "green", pulse: true, tap: true, keys: NEXT_KEYS, keyName: "space", fn: () => { sfx.click(); goStep(0); } }]);
    mode = { update: () => {}, draw: () => {} };
  }
  function showEmpty() {
    resetStep();
    setLabel("No pages yet");
    setOverlay([
      h("p", { class: "g-castrow", "aria-hidden": "true" }, "📖"),
      h("h2", { class: "g-big" }, book.title || "My Story"),
      h("p", { class: "g-sub" }, "This book has no pages yet."),
      h("p", { class: "g-sub g-muted" }, "Write some story first, then come back to play!"),
    ]);
    setCaption("", "This book has no pages yet.");
    setControls([{ icon: "🏠", label: "Back", color: "green", tap: true, keys: NEXT_KEYS, keyName: "space", fn: exit }]);
    mode = { update: () => {}, draw: () => {} };
  }
  function showEnd() {
    resetStep();
    setLabel("The End");
    const starText = stars ? "⭐".repeat(Math.min(stars, 8)) : "🌟";
    setOverlay([
      castRow(),
      h("h2", { class: "g-big" }, "The End!"),
      h("p", { class: "g-stars", "aria-hidden": "true" }, starText),
      h("p", { class: "g-sub" }, `You won ${stars} ${stars === 1 ? "star" : "stars"}!`),
      h("p", { class: "g-sub g-muted" }, book.title || ""),
    ]);
    setCaption("", `The End! You won ${stars} ${stars === 1 ? "star" : "stars"}!`);
    sfx.fanfare();
    say(`The End! Great job! You won ${stars} ${stars === 1 ? "star" : "stars"}!`);
    setControls([
      { icon: "🔁", label: "Play again", color: "green", pulse: true, tap: true, keys: NEXT_KEYS, keyName: "space", fn: () => { sfx.click(); stars = 0; goStep(0); } },
      { icon: "🏠", label: "Back", color: "gray", tap: true, keys: ["b"], keyName: "B", fn: exit },
    ]);
    mode = { update: () => {}, draw: () => {} };
    if (!finished) { finished = true; try { onFinish?.(stars); } catch (e) { console.error(e); } }
  }

  /* ---------------- main loop ---------------- */
  function frame(now) {
    if (!alive) return;
    if (!root.isConnected) { destroy(); return; } // another screen replaced us
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (mode) {
      try {
        mode.update?.(dt); updFx(dt);
        ctx.save();
        if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
        ctx.clearRect(-50, -50, W + 100, H + 100);
        mode.draw(); drawFx();
        ctx.restore();
      } catch (e) { console.error(e); mode = null; }
    }
    raf = requestAnimationFrame(frame);
  }
  if (!steps.length) showEmpty(); else showTitle();
  if (book.pages.length) panelFor(0); // start drawing page 1 while the title shows
  raf = requestAnimationFrame(frame);
  return { stop: destroy };
}
