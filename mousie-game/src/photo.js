/* ================= photo mode: Samar's painted characters in real photo places =================
   PHOTOS comes from build.py (assets/manifest.json with the pictures inlined as data URLs):
     { backgrounds: { jungle|cave_outside|cave_inside|treehouse: { file, w, h, ground, credit, anchor? } },
       characters:  { mousie|daddy|birdie|raptor|trex|snake|lion|firetruck:
                      { file?, w, h, facing, feet, credit, poses?: { name: { file, w, h, facing, feet } } } } }
   `ground` = fraction of the photo's height where its floor is; it is lined up with GROUND.
   `feet`   = fraction of the cut-out's height where it touches the ground.
   `anchor` (optional) = fraction of the photo's width where the cave opening / tree house is (default 0.5).
   Every hook below returns false when its picture is missing (or still loading), and the
   cartoon drawing is used instead, so the game always works. */
function photoUnpack(p, files) {
  for (const g of ["backgrounds", "characters"]) for (const e of Object.values(p[g] || {})) {
    if (typeof e.file === "number") e.file = files[e.file];
    for (const pe of Object.values(e.poses || {})) if (typeof pe.file === "number") pe.file = files[pe.file];
  }
  return p;
}
const PH = { ready: true, sprites: {}, bgs: {}, place: null, playAsap: false, tint: null, vignette: null };

// On-screen size at scale 1, close to the old cartoon drawing: px tall (h) or px wide (w).
// dy: how far below the y the game passes in the ground-contact line is (birds are placed by their body centre).
// sunk: how far below the ground the picture's bottom edge goes (the roaring T-Rex is painted without legs).
// sway: how much a walk tilts and bounces it. shadow: shadow width as a share of the picture width.
const PHOTO_SIZE = {
  mousie: { h: 115 }, daddy: { h: 115 },
  birdie: { h: 70, dy: 32, fly: { h: 80, dy: 0 } },
  raptor: { h: 140, dead: { w: 250, onBack: 165, shadow: 0.42 } },
  trex: { h: 320, sunk: 90, sway: 0.4, dead: { h: 300, sunk: 0, shadow: 0.4 } },
  snake: { h: 90, shadow: 0.4 }, lion: { h: 112, run: { h: 100, shadow: 0.4 } }, firetruck: { h: 130, shadow: 0.44 },
};
// Colour grade per place, baked into the background once: a soft-light wash pulls the photo's colours
// toward the warm paper tones of the paintings, then some colour is taken out and a little haze added.
const PHOTO_GRADE = {
  jungle: { soft: "rgb(255,226,160)", softA: 0.45, desat: 0.22, haze: "rgba(240,246,220,.10)", vig: 0.42 },
  cave_outside: { soft: "rgb(255,220,160)", softA: 0.4, desat: 0.25, haze: "rgba(240,240,220,.08)", vig: 0.45 },
  cave_inside: { soft: "rgb(255,170,90)", softA: 0.5, desat: 0.3, haze: "rgba(50,32,22,.12)", vig: 0.62 },
  treehouse: { soft: "rgb(255,210,130)", softA: 0.5, desat: 0.2, haze: "rgba(255,240,210,.10)", vig: 0.36 },
};

function photoCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
// Good-quality shrink: halve step by step (a single big downscale looks jagged), then scale to size.
function photoShrink(img, w, h) {
  let src = img, sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  while (sw > w * 2.2) {
    const c = photoCanvas(sw / 2, sh / 2), g = c.getContext("2d");
    g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const c = photoCanvas(w, h), g = c.getContext("2d");
  g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function photoBlend(g, mode) { g.globalCompositeOperation = mode; return g.globalCompositeOperation === mode; }

/* ---------- loading ---------- */
(function photoPreload() {
  if (!PHOTOS) return;
  const jobs = [];
  for (const [key, e] of Object.entries(PHOTOS.characters || {})) {
    if (e.file) jobs.push([e.file, (img) => photoAddSprite(key, "", e, img)]);
    for (const [pose, pe] of Object.entries(e.poses || {})) if (pe.file) jobs.push([pe.file, (img) => photoAddSprite(key, pose, pe, img)]);
  }
  for (const [key, e] of Object.entries(PHOTOS.backgrounds || {})) if (e.file) jobs.push([e.file, (img) => photoAddBg(key, e, img)]);
  if (!jobs.length) return;
  PH.ready = false;
  let left = jobs.length;
  const done = () => { if (--left === 0) photoAllLoaded(); };
  const safety = setTimeout(() => { left = 1; done(); }, 20000); // never get stuck on "Loading…"
  for (const [src, use] of jobs) {
    const img = new Image();
    img.onload = () => { try { use(img); } catch (err) { console.warn("photo skipped", err); } if (left > 0) done(); };
    img.onerror = () => { if (left > 0) done(); };
    img.src = src;
  }
  function photoAllLoaded() {
    clearTimeout(safety);
    if (PH.ready) return;
    PH.ready = true;
    if (game.step === -1 && !scene && !cut) { if (PH.playAsap) goStep(0); else goTitle(); }
  }
})();
function photoReady() { return PH.ready; }

function photoCfg(key, pose) {
  const base = PHOTO_SIZE[key] || { h: 100 };
  return pose ? { ...base, ...(base[pose] || {}) } : base;
}
function photoUnitH(cfg, meta) { return cfg.w ? cfg.w * meta.h / meta.w : cfg.h; }
function photoAddSprite(key, pose, meta, img) {
  meta = { ...meta, w: meta.w || img.naturalWidth, h: meta.h || img.naturalHeight, feet: meta.feet ?? 0.98 };
  const cfg = photoCfg(key, pose);
  const ch = Math.min(meta.h, Math.ceil(photoUnitH(cfg, meta) * 1.7)); // big enough for the largest use (Daddy at 1.45×)
  PH.sprites[key + "/" + pose] = { c: photoShrink(img, ch * meta.w / meta.h, ch), meta, cfg, pose };
}
function photoHas(key, pose = "") { return !!PH.sprites[key + "/" + pose]; }

/* ---------- characters ---------- */
const PHOTO_DRAWS = new Map([[drawBird, "birdie"], [drawRaptor, "raptor"], [drawTRex, "trex"], [drawSnake, "snake"], [drawLion, "lion"], [drawTruck, "firetruck"]]);
function photoKey(draw, o = {}) { return draw === drawMouse ? (o.color ? "daddy" : "mousie") : PHOTO_DRAWS.get(draw); }
function photoPoseFor(key, o) {
  if (o.dead) return "dead";
  if (o.roar) return "roar";
  if (key === "lion" && o.run) return "run";
  if (key === "birdie" && !o.legs) return "fly"; // Birdie only stands when drawn with legs
  return "";
}
// The cut-out to use, or null for the cartoon drawing. A missing pose falls back to the plain picture,
// except that a character without a plain picture (the Velociraptor) stays a drawing.
function photoSpriteFor(key, o) {
  if (!key || !PHOTOS) return null;
  const pose = photoPoseFor(key, o);
  return (pose && PH.sprites[key + "/" + pose]) || PH.sprites[key + "/"] || null;
}
// Speech-bubble height (in unscaled px above the y the actor stands at) for a cut-out character.
function photoHead(draw, more = {}) {
  if (!PHOTOS) return null;
  const key = photoKey(draw, more.o), e = key && PHOTOS.characters && PHOTOS.characters[key];
  if (!e) return null;
  let pose = photoPoseFor(key, more.o || {});
  let meta = (pose && e.poses && e.poses[pose]) || (e.file ? e : null);
  if (!meta) return null;
  if (meta === e) pose = "";
  const cfg = photoCfg(key, pose);
  return Math.round((meta.feet ?? 0.98) * photoUnitH(cfg, meta) - (cfg.dy || 0) - (cfg.sunk || 0)) + 4;
}

let photoTintCanvas = null;
// Draws the character's cut-out instead of the cartoon. Same arguments as the drawings:
// x, y = where it stands, s = scale, o = { t, walk, flip, rot, hurt, dead, roar, run, dizzy, wiggle, jy, ... }.
function photoChar(key, x, y, s, o) {
  const sp = photoSpriteFor(key, o);
  if (!sp) return false;
  const { meta, cfg, c: img } = sp, t = o.t || 0;
  const fly = sp.pose === "fly", dead = sp.pose === "dead";
  const dh = photoUnitH(cfg, meta) * s, dw = dh * meta.w / meta.h;
  let rot = o.rot || 0, ay = y + ((cfg.dy || 0) + (cfg.sunk || 0)) * s;
  // the cartoon Velociraptor plays dead by lying upside down (rot ≈ π, 165px up); the painting already lies down
  if (dead && cfg.onBack && Math.abs(rot) > 1.2) { ay += cfg.onBack; rot = 0; }
  // paintings can't move their legs, so they bob, tilt and breathe instead
  let lift = 0, wob = 0, sx = 1, sy = 1;
  const sway = cfg.sway ?? 1;
  if (dead) { /* still */ }
  else if (fly) { wob = Math.sin(t * 3.1) * 0.07; sy = 1 + Math.sin(t * 15) * 0.035; lift = Math.sin(t * 2.3) * 3 * s; }
  else if (sp.pose === "run") { const p = t * 14; lift = Math.abs(Math.sin(p)) * 8 * s; wob = Math.sin(p) * 0.06; sy = 1 - 0.04 * Math.cos(p * 2); }
  else if (key === "firetruck") { if (o.walk) { lift = Math.abs(Math.sin(t * 23)) * 1.6 * s; wob = Math.sin(t * 11) * 0.012; } }
  else if (key === "snake") { const f = o.wiggle ? 9 : 2.2; wob = Math.sin(t * f) * (o.wiggle ? 0.11 : 0.035); sx = 1 + Math.sin(t * f * 2) * (o.wiggle ? 0.05 : 0.012); sy = 2 - sx; }
  else if (o.walk) { const p = t * 9, q = Math.abs(Math.cos(p)); lift = Math.abs(Math.sin(p)) * 5 * s * sway; wob = Math.sin(p) * 0.07 * sway; sy = 1 - 0.035 * q * sway; sx = 1 + 0.02 * q * sway; }
  else { const b = Math.sin(t * 2.4); sy = 1 + 0.018 * b; sx = 1 - 0.008 * b; }
  if (o.roar) { wob += -0.035 + Math.sin(t * 38) * 0.012; sx *= 1.03; sy *= 1.03; }
  if (o.dizzy) wob += Math.sin(t * 11) * 0.12;
  if (o.wave) wob += Math.sin(t * 10) * 0.08; // a happy wiggle instead of a waving arm
  const mirror = (meta.facing === "left") !== !!o.flip; // pictures face meta.facing; flip=false means "face right"
  // soft contact shadow on the ground (shrinks and fades while hopping)
  if (!fly && !cfg.sunk) {
    const up = Math.max(0, -(o.jy || 0)) + lift, k = 1 / (1 + up / 90);
    const rx = dw * (cfg.shadow || 0.34) * k * (dead ? 1 : sx), gy = ay - (o.jy || 0);
    ctx.save(); ctx.translate(x, gy); ctx.scale(1, 0.17);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(20,12,4,${0.5 * k})`); g.addColorStop(0.6, `rgba(20,12,4,${0.3 * k})`); g.addColorStop(1, "rgba(20,12,4,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 7); ctx.fill();
    ctx.restore();
  }
  let pic = img;
  if (o.hurt > 0) { // quick flash: tint the cut-out (ctx.filter is not available in Safari)
    const tc = photoTintCanvas || (photoTintCanvas = photoCanvas(img.width, img.height));
    if (tc.width !== img.width || tc.height !== img.height) { tc.width = img.width; tc.height = img.height; }
    const g = tc.getContext("2d");
    g.globalCompositeOperation = "source-over"; g.clearRect(0, 0, tc.width, tc.height); g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = Math.floor(o.hurt * 30) % 2 ? "rgba(255,255,255,.7)" : "rgba(255,50,40,.55)"; g.fillRect(0, 0, tc.width, tc.height);
    pic = tc;
  }
  ctx.save();
  ctx.translate(x, ay - lift);
  if (rot) ctx.rotate(rot);
  ctx.scale(mirror ? -1 : 1, 1);
  if (wob) ctx.rotate(wob);
  ctx.scale(sx, sy);
  ctx.drawImage(pic, -dw / 2, -meta.feet * dh, dw, dh);
  ctx.restore();
  if (o.dizzy) photoStars(x, ay - meta.feet * dh * 0.9, t, s);
  if (cfg.sunk) photoRocks(); // the legless T-Rex stands behind a line of rocks
  return true;
}
function photoStars(x, y, t, s) {
  ctx.save(); ctx.font = `${Math.round(24 * s)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < 3; i++) {
    const a = t * 5 + i * 2.1;
    ctx.fillStyle = "#ffd75e"; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.strokeText("★", x + Math.cos(a) * 30 * s, y + Math.sin(a) * 9 * s); ctx.fillText("★", x + Math.cos(a) * 30 * s, y + Math.sin(a) * 9 * s);
  }
  ctx.restore();
}
// Boulders in front of the T-Rex (fixed in place on the right, where it stands), so the roaring
// T-Rex, painted without legs, is clearly standing behind them; its cut edge is also pushed below
// the bottom of the picture. Anything drawn after it (Mousie, the bomb, the beaten raptor) stays in front.
const PHOTO_ROCKS = [[478, 62, 120], [560, 80, 150], [655, 66, 120], [742, 88, 170], [840, 70, 130], [930, 84, 150], [1010, 72, 120]];
function photoRocks() {
  ctx.save();
  for (const [rx, rh, rw] of PHOTO_ROCKS) {
    const g = ctx.createLinearGradient(rx - rw / 3, H - rh, rx + rw / 4, H);
    g.addColorStop(0, "#7a6857"); g.addColorStop(0.3, "#4a3d32"); g.addColorStop(1, "#1d1713");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(rx, H + 4, rw / 2, rh + 4, 0, Math.PI, 0); ctx.fill();
  }
  ctx.restore();
}

/* ---------- backgrounds ---------- */
// Scale so the photo's floor line lands exactly on GROUND and it fills the frame top to bottom.
function photoAddBg(key, meta, img) {
  const iw = img.naturalWidth, ih = img.naturalHeight, g = Math.min(0.97, Math.max(0.3, +meta.ground || 0.8));
  const kTop = GROUND / (g * ih);
  const k = Math.min(Math.max(kTop, (H - GROUND) / ((1 - g) * ih)), kTop * 1.8); // floor too thin? stretch its last rows instead of zooming more
  const tw = Math.round(iw * k), th = Math.round(ih * k), oy = Math.round(GROUND - g * ih * k);
  const full = photoShrink(img, tw, th);
  const c = photoCanvas(tw, H), cg = c.getContext("2d");
  cg.drawImage(full, 0, oy);
  if (oy + th < H) cg.drawImage(full, 0, th - 3, tw, 3, 0, oy + th - 1, tw, H - oy - th + 1);
  const gr = PHOTO_GRADE[key] || PHOTO_GRADE.jungle;
  if (photoBlend(cg, "soft-light")) { cg.globalAlpha = gr.softA; cg.fillStyle = gr.soft; cg.fillRect(0, 0, tw, H); }
  if (photoBlend(cg, "saturation")) { cg.globalAlpha = gr.desat; cg.fillStyle = "#808080"; cg.fillRect(0, 0, tw, H); }
  cg.globalAlpha = 1; cg.globalCompositeOperation = "source-over";
  cg.fillStyle = gr.haze; cg.fillRect(0, 0, tw, H);
  // mirrored copy: tiles alternate normal / mirrored so the edges always match
  const m = photoCanvas(tw, H), mg = m.getContext("2d");
  mg.translate(tw, 0); mg.scale(-1, 1); mg.drawImage(c, 0, 0);
  PH.bgs[key] = { c, m, tw, meta, grade: gr };
}
// Fill [x0, x1) with tiles of a background; tile 0 (not mirrored) starts at `left`.
function photoTiles(b, left, x0 = 0, x1 = W) {
  left = Math.round(left);
  let n = Math.floor((x0 - left) / b.tw);
  for (let x = left + n * b.tw; x < x1; x += b.tw, n++) ctx.drawImage(n % 2 ? b.m : b.c, x, 0);
}
// Tiles from x0 to the right edge, fading in over `feather` px to the left of x0 (for places that slide in).
function photoBand(b, left, x0, feather) {
  ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, W + b.tw, H); ctx.clip(); photoTiles(b, left, x0, W); ctx.restore();
  const N = 18, sw = feather / N, a0 = ctx.globalAlpha;
  for (let i = 0; i < N; i++) {
    const sx = x0 - feather + i * sw, f = (i + 0.5) / N;
    if (sx + sw < -W || sx > W) continue;
    ctx.save(); ctx.globalAlpha = a0 * f * f * (3 - 2 * f);
    ctx.beginPath(); ctx.rect(sx, 0, sw + 0.6, H); ctx.clip(); photoTiles(b, left, sx, sx + sw + 1);
    ctx.restore();
  }
}
function photoForest(scroll, tint) {
  const b = PH.bgs.jungle;
  if (!b) return false;
  photoTiles(b, -scroll);
  if (tint) { ctx.fillStyle = `rgba(255,190,110,${tint})`; ctx.fillRect(0, 0, W, H); }
  PH.place = "jungle";
  return true;
}
function photoCave(scroll, hole) {
  const b = PH.bgs.cave_inside;
  if (!b) return false;
  photoTiles(b, -scroll);
  // warm light from the way in (left), darkness deeper in (right)
  const l = ctx.createRadialGradient(60, 330, 20, 60, 330, 560);
  l.addColorStop(0, "rgba(255,200,120,.28)"); l.addColorStop(1, "rgba(255,200,120,0)");
  ctx.fillStyle = l; ctx.fillRect(0, 0, W, H);
  const d = ctx.createLinearGradient(W * 0.4, 0, W, 0);
  d.addColorStop(0, "rgba(8,5,3,0)"); d.addColorStop(1, "rgba(8,5,3,.4)");
  ctx.fillStyle = d; ctx.fillRect(0, 0, W, H);
  if (hole) { // a dark tunnel further into the cave, where the dinosaurs come from
    ctx.save(); ctx.translate(830, 300); ctx.scale(1, 1.45);
    const h = ctx.createRadialGradient(0, 0, 10, 0, 0, 130);
    h.addColorStop(0, "rgba(4,3,2,.92)"); h.addColorStop(0.55, "rgba(4,3,2,.6)"); h.addColorStop(1, "rgba(4,3,2,0)");
    ctx.fillStyle = h; ctx.beginPath(); ctx.arc(0, 0, 130, 0, 7); ctx.fill();
    ctx.restore();
  }
  PH.place = "cave_inside";
  return true;
}
// The cave photo slides in with the camera: its opening is at screen x, and it blends into the
// jungle over a soft edge on the left, so walking along, "a cave appears".
function photoCaveMouth(x) {
  const b = PH.bgs.cave_outside;
  if (!b) return false;
  const a = b.meta.anchor ?? 0.5, left = x - a * b.tw;
  photoBand(b, left, x - Math.min(a * b.tw, 330), 260);
  PH.place = PH.place || "cave_outside";
  return true;
}
// Tree-house photo with the game's own ladder and deck (gameplay positions unchanged:
// ladder x ≈ 520–590 from GROUND up to y = 170, deck at y ≈ 160 from x 440 to 830).
// forest=false: only the tree-house layer, which fades in on its left so a scene can slide it in.
function photoTreeHouse(rungs, forest) {
  const b = PH.bgs.treehouse;
  if (!b) return false;
  const left = 625 - (b.meta.anchor ?? 0.5) * b.tw;
  if (forest) photoTiles(b, left); else photoBand(b, left, -40, 300);
  photoDeck(rungs);
  if (forest || !PH.place) PH.place = "treehouse";
  return true;
}
function photoWood(x0, y0, x1, y1, light = "#a8743f", dark = "#5a3a1c") {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  return g;
}
function photoDeck(rungs) {
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // shadow the deck casts on the tree behind it
  ctx.fillStyle = "rgba(10,6,2,.28)"; ctx.fillRect(446, 176, 392, 26);
  // stilts and braces
  for (const px of [452, 818]) {
    ctx.fillStyle = photoWood(px - 8, 0, px + 8, 0, "#8a5c30", "#3f2810"); ctx.fillRect(px - 8, 170, 16, GROUND - 160);
  }
  ctx.strokeStyle = "#5e3d1d"; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(456, 290); ctx.lineTo(500, 176); ctx.moveTo(814, 290); ctx.lineTo(770, 176); ctx.stroke();
  // doorway into the tree house (Daddy steps out of it)
  ctx.fillStyle = photoWood(0, 40, 0, 160, "#1c120b", "#0d0805"); ctx.fillRect(600, 50, 46, 110);
  ctx.fillStyle = photoWood(0, 30, 0, 160, "#9a6a38", "#6b4423"); ctx.fillRect(590, 44, 10, 116); ctx.fillRect(646, 44, 10, 116);
  ctx.fillStyle = photoWood(0, 32, 0, 50, "#b27e48", "#6b4423"); ctx.fillRect(582, 34, 82, 14);
  // railing with a gap at the ladder
  ctx.strokeStyle = "#7a522b"; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(444, 122); ctx.lineTo(512, 122); ctx.moveTo(660, 122); ctx.lineTo(826, 122); ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath(); for (const px of [446, 480, 512, 666, 700, 740, 780, 824]) { ctx.moveTo(px, 160); ctx.lineTo(px, 120); } ctx.stroke();
  // deck planks
  ctx.fillStyle = photoWood(0, 158, 0, 178, "#b98a52", "#6e4824"); ctx.fillRect(436, 158, 398, 18);
  ctx.strokeStyle = "rgba(50,30,12,.45)"; ctx.lineWidth = 1.5;
  ctx.beginPath(); for (let px = 460; px < 830; px += 30) { ctx.moveTo(px, 159); ctx.lineTo(px, 176); } ctx.stroke();
  ctx.fillStyle = "rgba(255,240,200,.25)"; ctx.fillRect(436, 158, 398, 2);
  // ladder (same geometry as the cartoon one), with a soft shadow on the photo
  const ladder = (dx, dy, rail, rung) => {
    ctx.strokeStyle = rail; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(520 + dx, GROUND + 10 + dy); ctx.lineTo(530 + dx, 170 + dy); ctx.moveTo(590 + dx, GROUND + 10 + dy); ctx.lineTo(590 + dx, 170 + dy); ctx.stroke();
    ctx.strokeStyle = rung; ctx.lineWidth = 6;
    ctx.beginPath(); for (let i = 0; i <= rungs; i++) { const ry = GROUND - i * 30 + 5 + dy; ctx.moveTo(522 + dx + i * 0.8, ry); ctx.lineTo(590 + dx, ry); } ctx.stroke();
  };
  ladder(6, 5, "rgba(10,6,2,.35)", "rgba(10,6,2,.3)");
  ladder(0, 0, photoWood(520, 0, 595, 0, "#a8743f", "#6b4423"), "#93643a");
  ctx.restore();
}
// Big dark out-of-focus leaves passing in front of the camera.
function photoJungleFront(scroll) {
  if (!PH.bgs.jungle) return false;
  const span = 1500;
  ctx.save();
  for (let i = 0; i < 5; i++) {
    const x = ((i * 330 - scroll * 1.5) % span + span) % span - 200;
    ctx.save(); ctx.translate(x, H + 20);
    for (let k = -3; k <= 3; k++) {
      ctx.save(); ctx.rotate(k * 0.3 - 0.1 + Math.sin(i * 7) * 0.1);
      const L = 120 + ((i * 5 + k * 3 + 21) % 5) * 14, w = 26 + (k & 1) * 6;
      ctx.fillStyle = k % 2 ? "rgba(6,20,8,.82)" : "rgba(12,32,12,.74)";
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(w, -L * 0.5, 0, -L); ctx.quadraticCurveTo(-w, -L * 0.5, 0, 0); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
  return true;
}
// After the background: a soft vignette (per place) so the photo frames the painted characters.
function photoAfterBg() {
  const place = PH.place;
  PH.place = null;
  if (!place) return;
  if (!PH.vignette) {
    const v = PH.vignette = photoCanvas(W, H), g = v.getContext("2d");
    g.translate(W / 2, H * 0.48); g.scale(1, H / W);
    const r = g.createRadialGradient(0, 0, W * 0.32, 0, 0, W * 0.72);
    r.addColorStop(0, "rgba(12,7,2,0)"); r.addColorStop(1, "rgba(12,7,2,1)");
    g.fillStyle = r; g.fillRect(-W, -W, W * 2, W * 2);
  }
  ctx.save(); ctx.globalAlpha = (PHOTO_GRADE[place] || PHOTO_GRADE.jungle).vig; ctx.drawImage(PH.vignette, 0, 0); ctx.restore();
}

/* ---------- credits ---------- */
function photoCreditItems() {
  const items = [];
  if (PHOTOS) {
    for (const [k, e] of Object.entries(PHOTOS.characters || {})) if (e.credit) items.push(["Character", k, e.credit]);
    for (const [k, e] of Object.entries(PHOTOS.backgrounds || {})) if (e.credit) items.push(["Background photo", k, e.credit]);
  }
  return items;
}
function photoFillCredits(list) {
  list.innerHTML = "";
  const add = (parent, tag, text, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text) el.textContent = text; parent.appendChild(el); return el; };
  const link = (parent, label, url) => {
    const p = add(parent, "p", label + ": ");
    if (/^https?:\/\//.test(url || "")) { const a = add(p, "a", url); a.href = url; a.target = "_blank"; a.rel = "noopener"; }
    else p.appendChild(document.createTextNode(url || "—"));
  };
  const book = add(list, "li");
  add(book, "strong", "Mousie, Part 1: story & pictures");
  add(book, "p", "By Samar. The characters in this game are cut out of his own comic.");
  for (const [kind, key, c] of photoCreditItems()) {
    const li = add(list, "li");
    add(li, "span", kind, "kind");
    add(li, "strong", c.title || key);
    add(li, "p", "By " + (c.author || "unknown"));
    const lic = add(li, "p", "Licence: ");
    if (/^https?:\/\//.test(c.licenseUrl || "")) { const a = add(lic, "a", c.license || c.licenseUrl); a.href = c.licenseUrl; a.target = "_blank"; a.rel = "noopener"; add(lic, "span", " (" + c.licenseUrl + ")", "url"); }
    else lic.appendChild(document.createTextNode(c.license || "—"));
    link(li, "Source", c.source);
  }
}
