// Drawing: scenes for each place, characters (emoji or a child's own drawing), and comic panels.
import { PLACES } from "./catalog.js";
import * as store from "./store.js";
import { loadImage } from "./images.js";

export const INK = "#3b2a1e";
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// Prepare drawable sprites for a book's cast: Map castId → sprite.
export async function loadSprites(book) {
  const map = new Map();
  for (const c of book.cast) {
    let img = null;
    if (c.imageId) {
      const url = await store.imageURL(c.imageId);
      if (url) { try { img = await loadImage(url); } catch { img = null; } }
    }
    // flip = artwork must be mirrored to face right. Drawings are assumed to face right;
    // the "Turn around" toggle in the editor fixes any that don't.
    const flip = img ? !!c.flip : (c.faces === "left") !== !!c.flip;
    map.set(c.id, { id: c.id, name: c.name, emoji: c.emoji, img, role: c.role, big: !!c.big, flip });
  }
  return map;
}

export function drawSprite(ctx, s, x, y, size, o = {}) {
  if (!s) return;
  const mirror = s.flip !== !!o.faceLeft;
  ctx.save();
  ctx.translate(x, y);
  if (o.rot) ctx.rotate(o.rot);
  if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
  ctx.scale(mirror ? -1 : 1, 1);
  if (o.squash) ctx.scale(1 + o.squash, 1 - o.squash);
  if (s.img) {
    const ar = s.img.width / s.img.height;
    const hgt = size, wid = size * ar;
    const scale = wid > size * 1.6 ? (size * 1.6) / wid : 1;
    ctx.drawImage(s.img, (-wid * scale) / 2, -hgt * scale, wid * scale, hgt * scale);
  } else {
    ctx.font = `${Math.round(size)}px ${EMOJI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s.emoji, 0, -size * 0.12);
  }
  ctx.restore();
}

export function drawEmoji(ctx, emoji, x, y, size, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${Math.round(size)}px ${EMOJI_FONT}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(emoji, x, y);
  ctx.restore();
}

export const groundY = (H) => Math.round(H * 0.84);

export function drawScene(ctx, W, H, placeKey, scroll = 0, t = 0) {
  const P = PLACES[placeKey] || PLACES.forest;
  const G = groundY(H);
  const g = ctx.createLinearGradient(0, 0, 0, G);
  g.addColorStop(0, P.sky[0]); g.addColorStop(1, P.sky[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (placeKey === "space" || placeKey === "cave") {
    ctx.fillStyle = placeKey === "space" ? "#fff" : "#2a211b";
    for (let i = 0; i < 40; i++) {
      const x = ((i * 137 - scroll * 0.05) % W + W) % W, y = (i * 71) % (G * 0.7);
      if (placeKey === "space") { ctx.globalAlpha = 0.4 + 0.5 * Math.abs(Math.sin(t * 2 + i)); ctx.fillRect(x, y, 3, 3); }
      else if (i < 14) { ctx.beginPath(); ctx.moveTo(i * W / 14, 0); ctx.lineTo(i * W / 14 + 40, 0); ctx.lineTo(i * W / 14 + 20, 40 + (i * 23) % 50); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = P.hill;
  for (let i = -1; i < 6; i++) {
    const hx = ((i * 260 - scroll * 0.15) % 1560 + 1560) % 1560 - 260;
    ctx.beginPath(); ctx.ellipse(hx * (W / 960), G, 220 * (W / 960), 130 * (H / 540), 0, Math.PI, 0); ctx.fill();
  }
  const layers = [[0.35, W / 3.2, H * 0.17, 0.75], [0.6, W / 2.2, H * 0.27, 1]];
  layers.forEach(([sp, gap, size, a], li) => {
    for (let i = -1; i < 7; i++) {
      const span = gap * 6;
      const x = ((i * gap - scroll * sp + li * gap * 0.45) % span + span) % span - gap * 0.5;
      drawEmoji(ctx, P.props[(i + 7 + li) % P.props.length], x, G - size * 0.42, size, a);
    }
  });
  ctx.fillStyle = P.ground; ctx.fillRect(0, G, W, H - G);
  ctx.fillStyle = P.path; ctx.fillRect(0, G + (H - G) * 0.2, W, (H - G) * 0.32);
  ctx.strokeStyle = INK; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, G); ctx.lineTo(W, G); ctx.stroke();
}

// Positions for characters standing in a scene.
export function layoutActors(actorIds, sprites, W, H) {
  const G = groundY(H);
  const good = [], bad = [];
  for (const id of actorIds.slice(0, 5)) { const s = sprites.get(id); if (s) (s.role === "villain" ? bad : good).push(s); }
  const out = [];
  good.forEach((s, i) => out.push({ s, x: W * (0.17 + i * 0.16), y: G + 4, size: H * 0.27, faceLeft: false }));
  bad.forEach((s, i) => out.push({ s, x: W * (0.8 - i * 0.16), y: G + 4, size: H * (s.big ? 0.46 : 0.32), faceLeft: true }));
  return out;
}

// One comic panel as a canvas: the child's photo, or a generated scene with the cast in it.
export async function renderPanel(page, sprites, W = 960, H = 600) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (page.imageId) {
    const url = await store.imageURL(page.imageId);
    if (url) {
      const img = await loadImage(url);
      ctx.fillStyle = "#fbf4e2"; ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.width, H / img.height);
      ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      return c;
    }
  }
  drawScene(ctx, W, H, page.place, page.place.length * 97);
  for (const a of layoutActors(page.actors, sprites, W, H)) drawSprite(ctx, a.s, a.x, a.y, a.size, { faceLeft: a.faceLeft });
  return c;
}
