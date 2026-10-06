// Unit tests for js/cutout.js (character cut-outs) on synthetic images. No browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maxflowGrid, cutoutRGBA, segment, autoCutRGBA, scoreCut, toPixelRect, components, kmeans, fitGMM } from "../js/cutout.js";

const DX = [1, -1, 0, 0, 1, -1, 1, -1], DY = [0, 0, 1, -1, 1, -1, -1, 1];
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

// Reference max-flow (Edmonds–Karp) for checking the Boykov–Kolmogorov solver.
function edmondsKarp(W, H, cap, src, snk) {
  const N = W * H + 2, S = N - 2, T = N - 1;
  const C = new Map(), adj = Array.from({ length: N }, () => new Set());
  const add = (a, b, c) => { if (c <= 0) return; C.set(a * N + b, (C.get(a * N + b) || 0) + c); adj[a].add(b); adj[b].add(a); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    add(S, i, src[i]); add(i, T, snk[i]);
    for (let d = 0; d < 8; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H) add(i, ny * W + nx, cap[i * 8 + d]); }
  }
  let flow = 0;
  for (;;) {
    const prev = new Int32Array(N).fill(-1); prev[S] = S;
    const q = [S];
    while (q.length && prev[T] < 0) { const u = q.shift(); for (const v of adj[u]) if (prev[v] < 0 && (C.get(u * N + v) || 0) > 1e-12) { prev[v] = u; q.push(v); } }
    if (prev[T] < 0) return flow;
    let f = Infinity;
    for (let v = T; v !== S; v = prev[v]) f = Math.min(f, C.get(prev[v] * N + v));
    for (let v = T; v !== S; v = prev[v]) { C.set(prev[v] * N + v, C.get(prev[v] * N + v) - f); C.set(v * N + prev[v], (C.get(v * N + prev[v]) || 0) + f); }
    flow += f;
  }
}

test("max-flow matches Edmonds–Karp and returns a minimum cut", () => {
  for (let t = 0; t < 150; t++) {
    const W = 2 + Math.floor(rnd() * 6), H = 2 + Math.floor(rnd() * 6), n = W * H;
    const cap = new Float64Array(n * 8), src = new Float64Array(n), snk = new Float64Array(n);
    for (let i = 0; i < n * 8; i++) cap[i] = rnd() < 0.7 ? Math.floor(rnd() * 10) : 0;
    for (let i = 0; i < n; i++) { src[i] = rnd() < 0.4 ? Math.floor(rnd() * 20) : 0; snk[i] = rnd() < 0.4 ? Math.floor(rnd() * 20) : 0; }
    const { flow, fg } = maxflowGrid(W, H, cap, src, snk);
    const want = edmondsKarp(W, H, cap, src, snk);
    assert.ok(Math.abs(flow - want) < 1e-6, `flow ${flow} vs ${want}`);
    let cut = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      cut += fg[i] ? snk[i] : src[i];
      if (fg[i]) for (let d = 0; d < 8; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && !fg[ny * W + nx]) cut += cap[i * 8 + d]; }
    }
    assert.ok(Math.abs(cut - want) < 1e-6, "cut value equals max flow");
  }
});

// A synthetic comic panel: textured green/blue scenery, a dark-outlined orange "character"
// (body ellipse + head circle + thin tail) and a white speech bubble near the corner.
function panel(W = 320, H = 240) {
  const px = new Uint8ClampedArray(W * H * 4), truth = new Uint8Array(W * H);
  const inBody = (x, y) => ((x - 150) / 60) ** 2 + ((y - 150) / 40) ** 2 <= 1;
  const inHead = (x, y) => (x - 205) ** 2 + (y - 100) ** 2 <= 28 ** 2;
  const inTail = (x, y) => x >= 60 && x <= 92 && Math.abs(y - (140 - (x - 60) * 0.9)) <= 3;
  const isChar = (x, y) => inBody(x, y) || inHead(x, y) || inTail(x, y);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, n = (rnd() - 0.5) * 30;
    let r, g, b;
    if (y > 170) { r = 90 + n; g = 150 + n; b = 70 + n; } // grass
    else { r = 150 + n; g = 200 + n; b = 235 + n; } // sky
    if ((x - 285) ** 2 + (y - 30) ** 2 < 22 ** 2) { r = g = b = 250; }
    if (isChar(x, y)) { r = 230 + n; g = 140 + n; b = 60 + n; truth[y * W + x] = 1; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  // dark ink outline, 2 px, around the character (counts as character)
  const out = new Uint8Array(truth);
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    if (truth[y * W + x]) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (truth[(y + dy) * W + x + dx]) { near = true; break; }
    if (near) { const i = (y * W + x) * 4; px[i] = 40; px[i + 1] = 30; px[i + 2] = 25; out[y * W + x] = 1; }
  }
  return { px, W, H, truth: out };
}

function iouOf(res, W, H, truth) {
  let inter = 0, uni = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ox = Math.floor((x + 0.5 - res.x) * res.scale), oy = Math.floor((y + 0.5 - res.y) * res.scale);
    const a = ox >= 0 && oy >= 0 && ox < res.w && oy < res.h && res.rgba[(oy * res.w + ox) * 4 + 3] > 127;
    const b = truth[y * W + x] === 1;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  return inter / uni;
}

test("cuts a dark-outlined character from a loose box (IoU ≥ 0.9, crop ≤ 512, transparent outside)", () => {
  const { px, W, H, truth } = panel();
  const res = cutoutRGBA(px, W, H, { x: 40, y: 50, w: 250, h: 160 });
  assert.ok(res, "a cut");
  assert.ok(Math.max(res.w, res.h) <= 512);
  const iou = iouOf(res, W, H, truth);
  assert.ok(iou >= 0.9, `IoU ${iou.toFixed(3)}`);
  // corners of the crop are transparent; the middle of the body is opaque
  assert.equal(res.rgba[3], 0);
  const cx = Math.round((150 - res.x) * res.scale), cy = Math.round((150 - res.y) * res.scale);
  assert.equal(res.rgba[(cy * res.w + cx) * 4 + 3], 255);
  assert.ok(scoreCut(res.seg.stats) > 0.5, "a clean cut scores well");
});

test("keep/remove strokes are honoured", () => {
  const { px, W, H } = panel();
  const rect = { x: 40, y: 50, w: 250, h: 160 };
  const keep = segment(px, W, H, rect, { strokes: [{ x: 60, y: 190, r: 6, keep: true }] });
  const at = (sg, x, y) => sg.mask[Math.floor((y - sg.oy) / sg.sy) * sg.gw + Math.floor((x - sg.ox) / sg.sx)];
  assert.equal(at(keep, 60, 190), 1, "kept grass stays");
  const rem = segment(px, W, H, rect, { strokes: [{ x: 205, y: 100, r: 10, keep: false }] });
  assert.equal(at(rem, 205, 100), 0, "removed spot is gone");
  assert.equal(at(rem, 150, 150), 1, "body is still there");
});

test("autoCutRGBA widens a box that clips the character", () => {
  const { px, W, H, truth } = panel();
  // Box misses the head and the tail.
  const res = autoCutRGBA(px, W, H, { x: 95, y: 112, w: 110, h: 80 });
  assert.ok(res && res.rect.w > 110 && res.rect.y < 112, "box grew");
  assert.ok(iouOf(res, W, H, truth) >= 0.85, `IoU ${iouOf(res, W, H, truth).toFixed(3)}`);
});

test("plain scenery scores lower than a character", () => {
  const { px, W, H } = panel();
  const sky = autoCutRGBA(px, W, H, { x: 230, y: 70, w: 80, h: 90 });
  const char = autoCutRGBA(px, W, H, { x: 40, y: 50, w: 250, h: 160 });
  assert.ok(!sky || sky.score < char.score);
});

test("toPixelRect clamps normalised boxes and rejects junk", () => {
  assert.deepEqual(toPixelRect({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, 200, 100), { x: 100, y: 25, w: 50, h: 50 });
  const r = toPixelRect({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 }, 100, 100);
  for (const [k, v] of Object.entries({ x: 0, y: 90, w: 30, h: 10 })) assert.ok(Math.abs(r[k] - v) < 1e-9, k);
  assert.equal(toPixelRect({ x: 0.2, y: 0.2, w: 0, h: 0.5 }, 100, 100), null);
  assert.equal(toPixelRect({ x: "a", y: 0, w: 1, h: 1 }, 100, 100), null);
  assert.equal(toPixelRect(null, 100, 100), null);
});

test("helpers: components, k-means and GMM fitting", () => {
  const m = Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 1, 1]);
  const { sizes } = components(m, 3, 3, 1);
  assert.deepEqual(sizes.slice(1), [2, 2]); // two separate pieces
  const pix = new Float32Array(600);
  for (let i = 0; i < 200; i++) { const v = i < 100 ? 20 : 220; pix[i * 3] = v + rnd(); pix[i * 3 + 1] = v; pix[i * 3 + 2] = v; }
  const idx = Array.from({ length: 200 }, (_, i) => i);
  const comp = kmeans(pix, idx, 2);
  assert.notEqual(comp[0], comp[199]);
  const g = fitGMM(pix, idx, comp, 2);
  assert.equal(g.k, 2);
});
