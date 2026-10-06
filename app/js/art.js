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
    ctx.font = `${Math.round(size)}px ${EMOJI_FONT}`; ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s.emoji, 0, -size * 0.12);
  }
  ctx.restore();
}

export function drawEmoji(ctx, emoji, x, y, size, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${Math.round(size)}px ${EMOJI_FONT}`; ctx.fillStyle = "#000";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(emoji, x, y);
  ctx.restore();
}

export const groundY = (H) => Math.round(H * 0.84);
// The top of a generated panel (this fraction of its height) is kept clear of characters and
// tall props, so speech bubbles and captions can sit there without hiding anyone.
export const SKY_SAFE = 0.36;

const NIGHT = new Set(["space", "cave", "ocean"]);
function drawSky(ctx, W, H, placeKey, P, scroll, t) {
  const G = groundY(H);
  if (placeKey === "space") {
    ctx.fillStyle = "#fff";
    for (let i = 0; i < 60; i++) {
      const x = ((i * 137 - scroll * 0.05) % W + W) % W, y = (i * 71) % (G * 0.8);
      ctx.globalAlpha = 0.4 + 0.5 * Math.abs(Math.sin(t * 2 + i));
      ctx.fillRect(x, y, 3, 3);
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (placeKey === "cave") {
    // Rocky ceiling with stalactites.
    ctx.fillStyle = "#2a211b";
    ctx.fillRect(0, 0, W, H * 0.05);
    for (let i = 0; i < 16; i++) {
      const x = i * W / 15 - ((scroll * 0.2) % (W / 15)), len = H * (0.07 + ((i * 23) % 7) / 60);
      ctx.beginPath(); ctx.moveTo(x - W / 34, H * 0.04); ctx.lineTo(x + W / 34, H * 0.04); ctx.lineTo(x, H * 0.04 + len); ctx.fill();
    }
    return;
  }
  if (placeKey === "ocean") {
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    for (let i = 0; i < 5; i++) {
      ctx.beginPath(); ctx.moveTo(W * (0.05 + i * 0.22), 0); ctx.lineTo(W * (0.13 + i * 0.22), 0); ctx.lineTo(W * (0.02 + i * 0.22), G); ctx.lineTo(W * (-0.04 + i * 0.22), G); ctx.fill();
    }
    return;
  }
  // Daytime: a sun and drifting puffy clouds.
  const sun = { x: W * 0.9, y: H * 0.12, r: H * 0.07 };
  ctx.fillStyle = "rgba(255,236,150,0.45)";
  ctx.beginPath(); ctx.arc(sun.x, sun.y, sun.r * 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffd75e";
  ctx.beginPath(); ctx.arc(sun.x, sun.y, sun.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  for (let i = 0; i < 4; i++) {
    const span = W * 1.4;
    const cx = ((i * W * 0.37 + W * 0.12 - scroll * 0.08 + t * 8) % span + span) % span - W * 0.2;
    const cy = H * (0.1 + (i % 2) * 0.12), r = H * 0.045;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.arc(cx + r * 1.1, cy - r * 0.5, r * 1.2, 0, Math.PI * 2);
    ctx.arc(cx + r * 2.3, cy, r, 0, Math.PI * 2); ctx.rect(cx, cy - r * 0.2, r * 2.3, r * 1.2);
    ctx.fill();
  }
}

export function drawScene(ctx, W, H, placeKey, scroll = 0, t = 0) {
  const P = PLACES[placeKey] || PLACES.forest;
  const key = PLACES[placeKey] ? placeKey : "forest";
  const G = groundY(H);
  const g = ctx.createLinearGradient(0, 0, 0, G);
  g.addColorStop(0, P.sky[0]); g.addColorStop(1, P.sky[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  drawSky(ctx, W, H, key, P, scroll, t);
  ctx.fillStyle = P.hill;
  for (let i = -1; i < 6; i++) {
    const hx = ((i * 260 - scroll * 0.15) % 1560 + 1560) % 1560 - 260;
    ctx.beginPath(); ctx.ellipse(hx * (W / 960), G, 220 * (W / 960), 130 * (H / 540), 0, Math.PI, 0); ctx.fill();
  }
  // Two layers of scenery (far ones paler and smaller); they stay below the bubble-safe sky.
  const layers = [[0.35, W / 3.2, H * 0.17, 0.75], [0.6, W / 2.2, H * 0.25, 1]];
  layers.forEach(([sp, gap, size, a], li) => {
    for (let i = -1; i < 7; i++) {
      const span = gap * 6;
      const x = ((i * gap - scroll * sp + li * gap * 0.45) % span + span) % span - gap * 0.5;
      drawEmoji(ctx, P.props[(i + 7 + li) % P.props.length], x, G - size * 0.42, size, a);
    }
  });
  ctx.fillStyle = P.ground; ctx.fillRect(0, G, W, H - G);
  ctx.fillStyle = P.path; ctx.fillRect(0, G + (H - G) * 0.2, W, (H - G) * 0.32);
  // A few tufts on the ground so it doesn't look flat.
  ctx.strokeStyle = NIGHT.has(key) ? "rgba(255,255,255,0.18)" : "rgba(59,42,30,0.25)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    const x = ((i * W / 8 + 37 - scroll) % W + W) % W, y = G + (H - G) * (i % 2 ? 0.75 : 0.12);
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x - 2, y - 7); ctx.moveTo(x + 2, y); ctx.lineTo(x + 5, y - 6); ctx.stroke();
  }
  ctx.strokeStyle = INK; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, G); ctx.lineTo(W, G); ctx.stroke();
}

// Positions for characters standing in a scene: friends on the left facing right, villains on
// the right facing left. Everyone fits between the bubble-safe sky and the ground.
export function layoutActors(actorIds, sprites, W, H) {
  const G = groundY(H);
  const good = [], bad = [];
  for (const id of actorIds.slice(0, 6)) { const s = sprites.get(id); if (s) (s.role === "villain" ? bad : good).push(s); }
  const out = [];
  const room = G - H * SKY_SAFE;
  const n = good.length + bad.length;
  const shrink = n > 4 ? 0.8 : 1;
  const spread = (list, from, to) => list.map((s, i) => from + (list.length === 1 ? (to - from) / 2 : (i * (to - from)) / (list.length - 1)));
  let gx, bx;
  if (!bad.length) gx = spread(good, good.length === 1 ? 0.3 : 0.2, good.length === 1 ? 0.3 : 0.8);
  else if (!good.length) bx = spread(bad, bad.length === 1 ? 0.68 : 0.3, bad.length === 1 ? 0.68 : 0.8);
  if (good.length && bad.length) {
    gx = spread(good, 0.14, Math.min(0.44, 0.14 + 0.12 * (good.length - 1)));
    bx = spread(bad, Math.max(0.62, 0.8 - 0.14 * (bad.length - 1)), 0.8).reverse();
  }
  good.forEach((s, i) => out.push({ s, x: W * gx[i], y: G + 4, size: Math.min(room, H * 0.3 * shrink), faceLeft: false }));
  bad.forEach((s, i) => out.push({ s, x: W * bx[i], y: G + 4, size: Math.min(room, H * (s.big ? 0.46 : 0.32) * shrink), faceLeft: true }));
  return out;
}

function shadow(ctx, x, y, size) {
  ctx.save();
  ctx.fillStyle = "rgba(40,28,18,0.22)";
  ctx.beginPath(); ctx.ellipse(x, y - 2, size * 0.32, size * 0.06, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Comic sound-effect words and doodles for action pages, drawn mid-panel (never in the sky).
function burst(ctx, x, y, r, word, fill) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(-0.12);
  ctx.beginPath();
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2, rr = i % 2 ? r * 0.7 : r; ctx.lineTo(Math.cos(a) * rr * 1.3, Math.sin(a) * rr); }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
  ctx.font = `900 ${Math.round(r * 0.62)}px "Chalkboard SE","Comic Sans MS","Marker Felt",cursive`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = 6; ctx.strokeStyle = "#fff"; ctx.strokeText(word, 0, 2);
  ctx.fillStyle = "#c62f22"; ctx.fillText(word, 0, 2);
  ctx.restore();
}
function drawFx(ctx, W, H, action, actors) {
  const G = groundY(H);
  const mid = (H * SKY_SAFE + G) / 2;
  if (action === "battle") {
    const xs = actors.map((a) => a.x);
    const x = xs.length > 1 ? (Math.min(...xs) + Math.max(...xs)) / 2 : W * 0.5;
    burst(ctx, x, mid, H * 0.1, "POW!", "#ffe14d");
  } else if (action === "celebrate") {
    const cols = ["#e0679a", "#3d7fd6", "#f0a040", "#5f9e45", "#9a5fc0", "#d8453b"];
    for (let i = 0; i < 46; i++) {
      ctx.fillStyle = cols[i % cols.length];
      const x = (i * 211) % W, y = H * SKY_SAFE * 0.6 + ((i * 97) % Math.round(G - H * SKY_SAFE * 0.6));
      ctx.save(); ctx.translate(x, y); ctx.rotate(i); ctx.fillRect(-6, -3, 12, 6); ctx.restore();
    }
  } else if (action === "collect") {
    for (let i = 0; i < 5; i++) drawEmoji(ctx, i % 2 ? "✨" : "💎", W * (0.4 + i * 0.07), G - H * 0.05 - (i % 2) * H * 0.08, H * 0.07);
  } else if (action === "friends") {
    for (let i = 0; i < 3; i++) drawEmoji(ctx, "💛", W * (0.42 + i * 0.08), mid - (i % 2) * H * 0.06, H * 0.06, 0.9);
  } else if (action === "journey") {
    ctx.save(); ctx.strokeStyle = "rgba(59,42,30,0.55)"; ctx.lineWidth = 4; ctx.lineCap = "round";
    const lead = actors.find((a) => !a.faceLeft);
    const x = lead ? lead.x - lead.size * 0.45 : W * 0.12, y = lead ? lead.y - lead.size * 0.5 : G - H * 0.15;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x - H * 0.03, y + i * H * 0.04); ctx.lineTo(x - H * 0.13, y + i * H * 0.04); ctx.stroke(); }
    ctx.restore();
  } else if (action === "climb") {
    ctx.save(); ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 7;
    const x = W * 0.9, top = H * SKY_SAFE + 10;
    ctx.beginPath(); ctx.moveTo(x - 24, G); ctx.lineTo(x - 24, top); ctx.moveTo(x + 24, G); ctx.lineTo(x + 24, top);
    for (let y = G - 26; y > top; y -= 34) { ctx.moveTo(x - 24, y); ctx.lineTo(x + 24, y); }
    ctx.stroke(); ctx.restore();
  }
}

// One comic panel as a canvas: the child's photo, or a generated scene with the cast in it.
// Generated scenes keep the top SKY_SAFE of the panel clear for speech bubbles.
export async function renderPanel(page, sprites, W = 960, H = 600) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (page.imageId) {
    const url = await store.imageURL(page.imageId);
    if (url) {
      try {
        const img = await loadImage(url);
        ctx.fillStyle = "#fbf4e2"; ctx.fillRect(0, 0, W, H);
        const s = Math.min(W / img.width, H / img.height);
        ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
        return c;
      } catch { /* fall back to a drawn scene */ }
    }
  }
  const place = String(page.place || "forest");
  drawScene(ctx, W, H, place, place.length * 97);
  const actors = layoutActors(page.actors || [], sprites, W, H);
  for (const a of actors) shadow(ctx, a.x, a.y, a.size);
  if (page.action === "battle" || page.action === "climb") drawFx(ctx, W, H, page.action, actors);
  for (const a of actors) drawSprite(ctx, a.s, a.x, a.y, a.size, { faceLeft: a.faceLeft });
  if (page.action && page.action !== "battle" && page.action !== "climb") drawFx(ctx, W, H, page.action, actors);
  return c;
}
