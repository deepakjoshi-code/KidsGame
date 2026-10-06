// Book importer: the pure parts (panel detection on synthetic pages, natural sort, text
// clean-up) plus checks that the vendored PDF.js matches THIRD_PARTY.md and is set up safely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPT, detectPanels, downsample, naturalCompare, normaliseText, cleanTitle, cleanStoryText, titleFromText } from "../js/importbook.js";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── synthetic pages ──
// A page is a function (x, y) → [r, g, b]; tilt rotates it about the centre.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const PAPER = [246, 240, 222]; // cream
const INK = [30, 25, 20];

function render(W, H, scene, { tiltDeg = 0, noise = 0, specks = 0, seed = 1 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const r = rng(seed), a = (tiltDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - W / 2, dy = y - H / 2;
    const sx = W / 2 + dx * c + dy * s, sy = H / 2 - dx * s + dy * c;
    const col = scene(sx, sy);
    const n = noise ? (r() - 0.5) * 2 * noise : 0;
    const i = (y * W + x) * 4;
    data[i] = col[0] + n; data[i + 1] = col[1] + n; data[i + 2] = col[2] + n; data[i + 3] = 255;
  }
  for (let k = 0; k < specks; k++) { // scan dust: 1–2 px dark dots
    const x = Math.floor(r() * (W - 2)), y = Math.floor(r() * (H - 2)), sz = r() < 0.5 ? 1 : 2;
    for (let yy = y; yy < y + sz; yy++) for (let xx = x; xx < x + sz; xx++) { const i = (yy * W + xx) * 4; data[i] = data[i + 1] = data[i + 2] = 20; }
  }
  return { width: W, height: H, data };
}

// Framed panels: { x, y, w, h } with a border of lw px and an interior that's either busy art
// ("art") or mostly white with a couple of pencil strokes ("sketch").
function panelsScene(panels, { lw = 3, fill = "art", extra = null } = {}) {
  return (x, y) => {
    if (extra) { const e = extra(x, y); if (e) return e; }
    for (const p of panels) {
      if (x < p.x || y < p.y || x >= p.x + p.w || y >= p.y + p.h) continue;
      if (x < p.x + lw || y < p.y + lw || x >= p.x + p.w - lw || y >= p.y + p.h - lw) return INK;
      if (fill === "art") {
        const v = (Math.sin(x * 0.11) + Math.cos(y * 0.07) + Math.sin((x + y) * 0.05)) * 40;
        return [90 + v, 150 + v / 2, 80 + v];
      }
      // sketch: white interior, a diagonal stroke and a circle
      const u = (x - p.x) / p.w, v = (y - p.y) / p.h;
      if (Math.abs(u - v) < 0.01 || Math.abs(Math.hypot(u - 0.6, v - 0.4) - 0.15) < 0.01) return INK;
      return PAPER;
    }
    return PAPER;
  };
}

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i);
};
function assertBoxes(got, want, minIou = 0.85) {
  assert.equal(got.length, want.length, `expected ${want.length} panels, got ${got.length}: ${JSON.stringify(got)}`);
  want.forEach((w, k) => assert.ok(iou(got[k], w) >= minIou, `panel ${k + 1}: ${JSON.stringify(got[k])} vs ${JSON.stringify(w)} (IoU ${iou(got[k], w).toFixed(2)})`));
}

const W = 480, H = 640;
const grid2x2 = [
  { x: 20, y: 20, w: 214, h: 290 }, { x: 246, y: 20, w: 214, h: 290 },
  { x: 20, y: 330, w: 214, h: 290 }, { x: 246, y: 330, w: 214, h: 290 },
];

test("2×2 grid → four panels in reading order", () => {
  assertBoxes(detectPanels(render(W, H, panelsScene(grid2x2))), grid2x2);
});

test("1 + 2 layout → wide top panel, then bottom left, bottom right", () => {
  const want = [{ x: 20, y: 20, w: 440, h: 280 }, { x: 20, y: 316, w: 210, h: 304 }, { x: 246, y: 316, w: 214, h: 304 }];
  assertBoxes(detectPanels(render(W, H, panelsScene(want))), want);
});

test("2 + 1 layout with sketchy white interiors stays per panel (lines through panels aren't gutters)", () => {
  const want = [{ x: 24, y: 24, w: 206, h: 300 }, { x: 250, y: 24, w: 206, h: 300 }, { x: 24, y: 344, w: 432, h: 272 }];
  assertBoxes(detectPanels(render(W, H, panelsScene(want, { lw: 2, fill: "sketch" }))), want);
});

test("single full-bleed picture → the whole page", () => {
  const out = detectPanels(render(W, H, panelsScene([{ x: 0, y: 0, w: W, h: H }], { lw: 0 })));
  assert.deepEqual(out, [{ x: 0, y: 0, w: W, h: H }]);
});

test("one framed picture with a margin → the whole page", () => {
  const out = detectPanels(render(W, H, panelsScene([{ x: 24, y: 24, w: 432, h: 592 }])));
  assert.deepEqual(out, [{ x: 0, y: 0, w: W, h: H }]);
});

test("cover-like page (drawings and lines of text, no frames) → the whole page", () => {
  const scene = (x, y) => {
    if (Math.abs(Math.hypot(x - 240, y - 110) - 80) < 3) return INK; // title cloud
    if (Math.abs(Math.hypot(x - 200, y - 300) - 60) < 3) return [200, 120, 120]; // a mouse
    for (const ty of [470, 510, 550]) if (y > ty && y < ty + 18 && x > 60 && x < 420 && (x % 14) < 9) return INK; // text
    return PAPER;
  };
  assert.deepEqual(detectPanels(render(W, H, scene)), [{ x: 0, y: 0, w: W, h: H }]);
});

test("noisy scan: paper grain, dust and a dark scanner edge still give the 2×2 grid", () => {
  const base = panelsScene(grid2x2);
  const scene = (x, y) => (x < 8 || y > H - 6 ? [40, 40, 45] : base(x, y)); // dark strip left + bottom
  const out = detectPanels(render(W, H, scene, { noise: 18, specks: 600, seed: 7 }));
  assertBoxes(out, grid2x2, 0.8);
});

test("tilted page (1.5°) with thin 1 px borders → four panels", () => {
  const scene = panelsScene(grid2x2, { lw: 1, fill: "sketch" });
  const out = detectPanels(render(W, H, scene, { tiltDeg: 1.5, noise: 6, seed: 3 }));
  assertBoxes(out, grid2x2, 0.75);
});

test("tilted the other way (-2°) with art-filled panels → four panels", () => {
  const out = detectPanels(render(W, H, panelsScene(grid2x2, { lw: 2 }), { tiltDeg: -2 }));
  assertBoxes(out, grid2x2, 0.75);
});

test("a page number and a caption under the panels are dropped", () => {
  const panels = [{ x: 20, y: 20, w: 440, h: 270 }, { x: 20, y: 306, w: 440, h: 270 }];
  const extra = (x, y) => ((y > 600 && y < 616 && x > 232 && x < 248 && x % 5 < 3) || (y > 588 && y < 596 && x > 60 && x < 200) ? INK : null);
  assertBoxes(detectPanels(render(W, H, panelsScene(panels, { extra }))), panels);
});

test("a bubble spike poking into a narrow gutter doesn't merge the panels", () => {
  const panels = [{ x: 20, y: 20, w: 440, h: 300 }, { x: 20, y: 330, w: 440, h: 290 }];
  // A triangle rising from the lower panel, its tip 2 px short of the upper panel.
  const extra = (x, y) => (y >= 322 && y < 332 && Math.abs(x - 300) < (332 - y) * 1.5 ? [230, 120, 60] : null);
  assertBoxes(detectPanels(render(W, H, panelsScene(panels, { extra }))), panels);
});

test("seven-panel page (3 rows of 2 + 1 wide)", () => {
  const want = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) want.push({ x: 20 + c * 226, y: 20 + r * 150, w: 214, h: 138 });
  want.push({ x: 20, y: 470, w: 440, h: 150 });
  assertBoxes(detectPanels(render(W, H, panelsScene(want))), want);
});

test("minPanelArea discards small boxes; degenerate input → whole page", () => {
  const out = detectPanels(render(W, H, panelsScene(grid2x2)), { minPanelArea: 0.3 });
  assert.deepEqual(out, [{ x: 0, y: 0, w: W, h: H }]);
  assert.deepEqual(detectPanels({ width: 4, height: 4, data: new Uint8Array(64) }), [{ x: 0, y: 0, w: 4, h: 4 }]);
  assert.deepEqual(detectPanels({ width: 50, height: 50, data: new Uint8Array(10) }), [{ x: 0, y: 0, w: 50, h: 50 }]);
  const black = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(0) };
  assert.deepEqual(detectPanels(black), [{ x: 0, y: 0, w: 64, h: 64 }]);
});

test("a blank or solid fragment (scanner shadow, empty paper block) is not a panel", () => {
  const panels = [{ x: 20, y: 20, w: 440, h: 270 }, { x: 20, y: 306, w: 210, h: 314 }];
  const extra = (x, y) => (x >= 250 && x < 460 && y >= 306 && y < 620 ? [120, 120, 120] : null); // flat grey block
  assertBoxes(detectPanels(render(W, H, panelsScene(panels, { extra }))), panels);
});

test("results don't depend on the page's pixel size (same panels at 1×, 2× and 2.6×)", () => {
  const want = [{ x: 20, y: 20, w: 440, h: 280 }, { x: 20, y: 316, w: 210, h: 304 }, { x: 246, y: 316, w: 214, h: 304 }];
  for (const k of [1, 2, 2.6]) {
    const scene = panelsScene(want);
    const img = render(Math.round(W * k), Math.round(H * k), (x, y) => scene(x / k, y / k), { noise: 8, seed: 5 });
    const got = detectPanels(img).map((b) => ({ x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k }));
    assertBoxes(got, want, 0.9);
  }
  const a = render(W * 2, H * 2, panelsScene(grid2x2));
  assert.deepEqual(detectPanels(a), detectPanels(a), "deterministic");
});

test("downsample is an exact area average", () => {
  const img = { width: 4, height: 2, data: new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 10, 20, 30, 255, 10, 20, 30, 255, 200, 200, 200, 255, 100, 100, 100, 255, 10, 20, 30, 255, 10, 20, 30, 255]) };
  const d = downsample(img, 2);
  assert.equal(d.width, 2); assert.equal(d.height, 1);
  assert.deepEqual([...d.data], [100, 100, 100, 255, 10, 20, 30, 255]);
  assert.equal(downsample(img, 10), img);
});

// ── text helpers ──

test("natural sort orders page2 before page10, case-insensitively", () => {
  const names = ["page10.jpg", "Page2.jpg", "page1.jpg", "page 3.png", "IMG_0100.HEIC", "IMG_0099.jpg", "cover.jpg"];
  assert.deepEqual([...names].sort(naturalCompare), ["cover.jpg", "IMG_0099.jpg", "IMG_0100.HEIC", "page1.jpg", "Page2.jpg", "page 3.png", "page10.jpg"]);
  assert.ok(naturalCompare("a", "a") === 0);
  assert.ok(naturalCompare("x9", "x10") < 0);
});

test("normaliseText makes one tidy paragraph", () => {
  assert.equal(normaliseText("  Once upon\n\n a  time,\tthere   was\r\na mouse.  "), "Once upon a time, there was a mouse.");
  assert.equal(normaliseText("a big adven-\nture began"), "a big adventure began");
  assert.equal(normaliseText("T-Rex\u00A0came!\u2028Run\u00AD!"), "T-Rex came! Run!");
  assert.equal(normaliseText("bad\u0000chars\uFFFDhere"), "bad chars here");
  assert.equal(normaliseText(null), "");
  assert.ok(!/\n/.test(normaliseText("one\n\n\ntwo")));
});

test("cleanStoryText keeps paragraphs but drops BOM, CRs and extra blank lines", () => {
  assert.equal(cleanStoryText("\uFEFFTitle\r\n\r\n\r\n\r\nPip ran.  \r\nThe end."), "Title\n\nPip ran.\nThe end.");
});

test("titleFromText takes a short first line as the title of a .txt story", () => {
  assert.deepEqual(titleFromText("Pip and the Moon\n\nOnce upon a time Pip flew."), { title: "Pip and the Moon", rest: "Once upon a time Pip flew." });
  assert.deepEqual(titleFromText("# The Dragon Cave\nA dragon lived in a cave."), { title: "The Dragon Cave", rest: "A dragon lived in a cave." });
  assert.equal(titleFromText("Once upon a time there was a mouse.\nShe ran."), null, "a sentence isn't a title");
  assert.equal(titleFromText("\"Hello!\" said Pip\nand ran."), null);
  assert.equal(titleFromText("Just one line"), null, "nothing after it");
  assert.equal(titleFromText("This first line is far too long to be the title of a story book, surely\nmore"), null);
});

test("cleanTitle turns file names into book titles and drops scanner names", () => {
  assert.equal(cleanTitle("MousieBook1.jpg.pdf"), "Mousie Book 1");
  assert.equal(cleanTitle("a3b67d45-MousieBook1.jpg.pdf"), "Mousie Book 1");
  assert.equal(cleanTitle("the_dragon_cave.pdf"), "the dragon cave");
  assert.equal(cleanTitle("Microsoft Word - Pip and the Moon.docx"), "Pip and the Moon");
  for (const junk of ["1.jpg", "IMG_0042.HEIC", "Scan 3.pdf", "untitled", "", "page-01.png", "Document.pdf"]) assert.equal(cleanTitle(junk), "", junk);
});

test("ACCEPT covers PDFs, pictures (incl. HEIC) and plain text", () => {
  assert.equal(ACCEPT, ".pdf,application/pdf,image/*,.heic,.txt,text/plain");
});

// ── vendored PDF.js ──

test("vendored files match the SHA-256 sums in THIRD_PARTY.md, and nothing unlisted is vendored", () => {
  const md = readFileSync(join(APP, "THIRD_PARTY.md"), "utf8");
  const listed = new Map([...md.matchAll(/`(vendor\/[^`]+)`[^\n]*?`([0-9a-f]{64})`/g)].map((m) => [m[1], m[2]]));
  const onDisk = [];
  const walk = (d) => { for (const n of readdirSync(join(APP, d), { withFileTypes: true })) n.isDirectory() ? walk(`${d}/${n.name}`) : onDisk.push(`${d}/${n.name}`); };
  walk("vendor");
  assert.deepEqual(onDisk.sort(), [...listed.keys()].sort(), "every vendored file is listed in THIRD_PARTY.md with its SHA-256");
  for (const [f, sum] of listed) assert.equal(createHash("sha256").update(readFileSync(join(APP, f))).digest("hex"), sum, f);
});

test("PDF.js is loaded lazily, from the app's own folder, with eval and WebAssembly off", () => {
  const src = readFileSync(join(APP, "js/importbook.js"), "utf8");
  assert.ok(!/^\s*import\s[^(]*pdfjs/m.test(src), "no static import of PDF.js (it loads only when a PDF is chosen)");
  assert.match(src, /import\("\.\.\/vendor\/pdfjs\/pdf\.min\.js"\)/);
  assert.match(src, /new URL\("\.\.\/vendor\/pdfjs\/pdf\.worker\.min\.js", import\.meta\.url\)/);
  for (const opt of [/isEvalSupported:\s*false/, /useWasm:\s*false/, /enableXfa:\s*false/]) assert.match(src, opt);
  assert.ok(!/cMapUrl|standardFontDataUrl|wasmUrl|iccUrl/.test(src.replace(/\/\/.*$/gm, "")), "no font/CMap/wasm URLs: nothing extra is fetched");
});
