// Book importer: turns a child's finished book (a scanned or printed comic as a PDF, photos of
// the pages, or a plain-text story) into page pictures and text the editor can use.
// Everything runs on the device. PDFs are read with Mozilla PDF.js, vendored in vendor/pdfjs/
// (see THIRD_PARTY.md) and loaded only when a PDF is chosen. It never fetches anything remote:
// no CMaps, no standard font files and no WebAssembly are used (see SECURITY.md).
import { pagePhoto } from "./images.js";
import { MAX_PAGES } from "./story.js";

export const ACCEPT = ".pdf,application/pdf,image/*,.heic,.txt,text/plain";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PDF_LONG_SIDE = 1600; // rendered page size (px, long side)
const PDF_MAX_AREA = 1600 * 1600; // memory clamp for odd page shapes
const PDF_MAX_SCALE = 4;
const PANEL_ANALYSIS_SIDE = 640; // panel detection works on a small copy of the page
const JPEG_QUALITY = 0.85;

// ───────────────────────── pure helpers (unit-tested in Node) ─────────────────────────

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
/** Natural sort for file names: "page2" < "page10". */
export function naturalCompare(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  const ka = a.replace(/[\s_-]+/g, ""), kb = b.replace(/[\s_-]+/g, ""); // "page 3" sorts as "page3"
  if (collator) { const c = collator.compare(ka, kb) || collator.compare(a, b); if (c) return c; }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Text from a PDF page → one tidy paragraph: no blank lines, single spaces, joined hyphenation. */
export function normaliseText(s) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/\u00AD/g, "") // soft hyphens
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, " ")
    .replace(/(\p{Ll})[-\u2010]\s*\n\s*(\p{Ll})/gu, "$1$2") // "adven-\nture" → "adventure"
    .replace(/[\s\u00A0\u2000-\u200B\u2028\u2029\u3000]+/g, " ")
    .trim();
}

/** A .txt file's contents → story text (keeps paragraphs for story.buildBook). */
export function cleanStoryText(s) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t\u00A0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A plain-text story's first line, when it looks like a title (short, no sentence ending, more
 * text after it). Returns { title, rest } with the title line removed, or null.
 */
export function titleFromText(text) {
  const m = /^\s*([^\n]+)\n+([\s\S]*\S[\s\S]*)$/.exec(String(text ?? ""));
  if (!m) return null;
  const line = m[1].trim().replace(/^#+\s*/, "").replace(/^title\s*:\s*/i, "");
  const words = line.split(/\s+/).filter(Boolean).length;
  if (!line || line.length > 60 || words > 10 || /[.,;:!?"'\u201D]$/.test(line) || /^[-*\u2022]/.test(line) || /["\u201C\u201D]/.test(line)) return null;
  return { title: line, rest: m[2].trim() };
}

const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|txt|docx?|pages|odt|rtf)$/i;
/** File name or PDF Title → a friendly book title ("" when it's just a camera/scanner name). */
export function cleanTitle(name) {
  let t = String(name ?? "").normalize("NFC").trim();
  t = t.replace(/^Microsoft (Word|PowerPoint) - /i, "");
  while (FILE_EXT.test(t)) t = t.replace(FILE_EXT, "");
  t = t.replace(/^[0-9a-f]{8}-(?=\S)/i, ""); // upload/download prefixes like "a3b67d45-"
  t = t.replace(/[_]+/g, " ").replace(/(\S)-(?=\S)/g, "$1 ").replace(/\s+-\s+/g, " ");
  t = t.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{L})(\d)/gu, "$1 $2");
  t = t.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  if (/^(untitled|document|scan|scanned|image|img|photo|picture|page|dsc|dcim|pxl|screenshot|book)?[\s\d.,:()-]*$/i.test(t)) return "";
  return t.slice(0, 80);
}

// ── Panel detection ──
// Input: ImageData-like { width, height, data: RGBA bytes }. Output: boxes in its pixel space,
// in reading order. When the page isn't a clean grid of ≥2 panels, returns the whole page.

/** Paper colour = the most common light colour; ink = anything clearly different from it. */
function inkMask(data, W, H) {
  const N = W * H;
  const hist = new Uint32Array(4096);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    if (r * 3 + g * 6 + b >= 1300) hist[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
  }
  let best = -1, bestN = 0;
  for (let k = 0; k < 4096; k++) if (hist[k] > bestN) { bestN = hist[k]; best = k; }
  if (best < 0 || bestN < N * 0.01) return null; // no paper to speak of
  let pr = 0, pg = 0, pb = 0, n = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    if ((((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)) === best) { pr += r; pg += g; pb += b; n++; }
  }
  pr /= n; pg /= n; pb /= n;
  const pl = (pr * 3 + pg * 6 + pb) / 10;
  const ink = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const d = Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb);
    const l = (r * 3 + g * 6 + b) / 10;
    if (d > 80 || l < pl * 0.72) ink[i] = 1;
  }
  return ink;
}

/** Drop tiny specks (scan dust, JPEG noise): 8-connected components smaller than minSize. */
function despeckle(ink, W, H, minSize) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comp = new Int32Array(minSize);
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || seen[s]) continue;
    let sp = 0, cn = 0;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp];
      if (cn < minSize) comp[cn] = p;
      cn++;
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (ink[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    if (cn < minSize) for (let k = 0; k < cn; k++) ink[comp[k]] = 0;
  }
}

/** Counts of gutter-like (near-empty) rows and columns strictly inside the content, at a tilt. */
function gutterScore(xs, ys, n, W, H, t) {
  const pad = Math.ceil(Math.abs(t) * Math.max(W, H)) + 2;
  const rows = new Uint32Array(H + 2 * pad), cols = new Uint32Array(W + 2 * pad);
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    rows[Math.round(y - x * t) + pad]++;
    cols[Math.round(x + y * t) + pad]++;
  }
  const empties = (a, tol) => {
    let lo = 0, hi = a.length - 1;
    while (lo < hi && a[lo] <= tol) lo++;
    while (hi > lo && a[hi] <= tol) hi--;
    let c = 0;
    for (let k = lo; k <= hi; k++) if (a[k] <= tol) c++;
    return c;
  };
  return empties(rows, Math.max(1, Math.round(W * 0.003))) + empties(cols, Math.max(1, Math.round(H * 0.003)));
}

/** Small page tilt (±3°) that makes the gutters straightest. Returns radians (0 when level). */
function estimateSkew(ink, W, H) {
  let n = 0;
  for (let i = 0; i < W * H; i++) n += ink[i];
  if (!n) return 0;
  const step = n > 200000 ? 2 : 1; // subsample very inky pages (bins stay 1px wide)
  const xs = new Int32Array(Math.ceil(n / step) + 1), ys = new Int32Array(xs.length);
  let m = 0, k = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x] && (k++ % step === 0)) { xs[m] = x; ys[m] = y; m++; }
  const angles = [];
  for (let d = -3; d <= 3.0001; d += 0.25) angles.push(d);
  const scores = angles.map((d) => gutterScore(xs, ys, m, W, H, Math.tan((d * Math.PI) / 180)));
  const zero = scores[angles.indexOf(0)];
  const best = Math.max(...scores);
  if (best <= zero) return 0;
  // Centre of the best plateau nearest to level.
  const idx = scores.map((s, i) => (s === best ? i : -1)).filter((i) => i >= 0);
  idx.sort((a, b) => Math.abs(angles[a]) - Math.abs(angles[b]));
  let lo = idx[0], hi = idx[0];
  while (lo > 0 && scores[lo - 1] === best) lo--;
  while (hi < angles.length - 1 && scores[hi + 1] === best) hi++;
  return (((angles[lo] + angles[hi]) / 2) * Math.PI) / 180;
}

/** Source coordinates of a point in the de-tilted frame. */
function unrotate(x, y, W, H, a) {
  const cx = W / 2, cy = H / 2, c = Math.cos(a), s = Math.sin(a);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}
function rotateMask(ink, W, H, a) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [sx, sy] = unrotate(x, y, W, H, a);
    const ix = Math.round(sx), iy = Math.round(sy);
    if (ix >= 0 && iy >= 0 && ix < W && iy < H) out[y * W + x] = ink[iy * W + ix];
  }
  return out;
}

function profile(ink, W, r, axis) {
  const { x0, y0, x1, y1 } = r;
  const out = new Uint32Array(axis === "y" ? y1 - y0 : x1 - x0);
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    for (let x = x0; x < x1; x++) if (ink[row + x]) out[axis === "y" ? y - y0 : x - x0]++;
  }
  return out;
}

/** Recursive XY-cut on clean gutters. */
function xyCut(ink, W, H, maxDepth) {
  const minGap = Math.max(2, Math.round(Math.min(W, H) * 0.006));
  const tolFor = (len) => Math.max(1, Math.round(len * 0.003));
  const out = [];
  // Trimming is lenient: a doodle, sparkle or page number in the margin next to a panel is
  // shaved off rather than stretching the panel's box.
  const trimTol = (len) => Math.max(tolFor(len), Math.round(len * 0.03));
  const trim = (r) => {
    const py = profile(ink, W, r, "y"), ty = trimTol(r.x1 - r.x0);
    let a = 0, b = py.length - 1;
    while (a <= b && py[a] <= ty) a++;
    while (b >= a && py[b] <= ty) b--;
    if (a > b) return null;
    const r2 = { x0: r.x0, x1: r.x1, y0: r.y0 + a, y1: r.y0 + b + 1 };
    const px = profile(ink, W, r2, "x"), tx = trimTol(r2.y1 - r2.y0);
    let c = 0, d = px.length - 1;
    while (c <= d && px[c] <= tx) c++;
    while (d >= c && px[d] <= tx) d--;
    if (c > d) return null;
    return { x0: r.x0 + c, x1: r.x0 + d + 1, y0: r2.y0, y1: r2.y1 };
  };
  const split = (r, axis) => {
    const p = profile(ink, W, r, axis);
    const span = axis === "y" ? r.x1 - r.x0 : r.y1 - r.y0;
    // A gutter is a run of nearly empty lines that is truly empty somewhere (a line through a
    // panel always crosses its frame, so it never is), or a short run between two panels that a
    // bubble or a "ROOR!" spike pokes into.
    const tol = tolFor(span), loose = Math.max(tol, Math.round(span * 0.1));
    const crowdedTol = Math.max(tol, Math.round(span * 0.02)), crowdedLen = Math.round(Math.max(W, H) * 0.05);
    const base = axis === "y" ? r.y0 : r.x0;
    const segs = [];
    let start = 0, k = 0;
    while (k < p.length) {
      if (p[k] > loose) { k++; continue; }
      let e = k, min = Infinity;
      while (e < p.length && p[e] <= loose) { if (p[e] < min) min = p[e]; e++; }
      const len = e - k, ok = min <= tol || (min <= crowdedTol && len <= crowdedLen);
      if (len >= minGap && ok && k > start && e < p.length) { segs.push([start, k]); start = e; }
      k = e;
    }
    if (start < p.length) segs.push([start, p.length]);
    return segs.map(([s, e]) => (axis === "y" ? { x0: r.x0, x1: r.x1, y0: base + s, y1: base + e } : { x0: base + s, x1: base + e, y0: r.y0, y1: r.y1 }));
  };
  const visit = (r0, depth) => {
    const r = trim(r0);
    if (!r) return;
    if (depth < maxDepth) {
      for (const axis of ["y", "x"]) {
        const segs = split(r, axis);
        if (segs.length >= 2) { for (const s of segs) visit(s, depth + 1); return; }
      }
    }
    out.push(r);
  };
  visit({ x0: 0, y0: 0, x1: W, y1: H }, 0);
  return out;
}

/** How much of each side of a box is drawn on (a frame line, or art running to the edge). */
function edgeCoverage(ink, W, r) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const side = (len, hit) => { let c = 0; for (let k = 0; k < len; k++) if (hit(k)) c++; return c / len; };
  const anyRow = (x, ya, yb) => { for (let y = ya; y < yb; y++) if (ink[y * W + x]) return true; return false; };
  const anyCol = (y, xa, xb) => { const row = y * W; for (let x = xa; x < xb; x++) if (ink[row + x]) return true; return false; };
  return Math.min(
    side(w, (k) => anyRow(r.x0 + k, r.y0, r.y0 + band)),
    side(w, (k) => anyRow(r.x0 + k, r.y1 - band, r.y1)),
    side(h, (k) => anyCol(r.y0 + k, r.x0, r.x0 + band)),
    side(h, (k) => anyCol(r.y0 + k, r.x1 - band, r.x1)),
  );
}

/**
 * Find comic panels on a page. Pure: works on any ImageData-like object.
 * @returns {{x:number,y:number,w:number,h:number}[]} reading order; [whole page] if no clean grid.
 */
export function detectPanels(img, { minPanelArea = 0.06, maxDepth = 5 } = {}) {
  const IW = img?.width | 0, IH = img?.height | 0;
  const whole = [{ x: 0, y: 0, w: IW, h: IH }];
  if (IW < 16 || IH < 16 || !img.data || img.data.length < IW * IH * 4) return whole;
  // Always analyse at the same size, so results don't depend on how big the page was rendered.
  const small = downsample(img, PANEL_ANALYSIS_SIDE);
  const kx = IW / small.width, ky = IH / small.height;
  const boxes = findPanels(small, minPanelArea, maxDepth);
  if (boxes.length < 2) return whole;
  return boxes.map((b) => {
    const x = Math.max(0, Math.floor(b.x * kx)), y = Math.max(0, Math.floor(b.y * ky));
    return { x, y, w: Math.min(IW, Math.ceil((b.x + b.w) * kx)) - x, h: Math.min(IH, Math.ceil((b.y + b.h) * ky)) - y };
  });
}

/** Deterministic area-average downscale (no canvas resampling, which differs between devices). */
export function downsample(img, maxSide) {
  const { width: W, height: H, data } = img;
  const s = Math.max(W, H) / maxSide;
  if (s <= 1) return img;
  const w = Math.max(1, Math.round(W / s)), h = Math.max(1, Math.round(H / s));
  const out = new Uint8ClampedArray(w * h * 4);
  const xs = new Int32Array(w + 1), ys = new Int32Array(h + 1);
  for (let x = 0; x <= w; x++) xs[x] = Math.min(W, Math.round((x * W) / w));
  for (let y = 0; y <= h; y++) ys[y] = Math.min(H, Math.round((y * H) / h));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = ys[y]; sy < Math.max(ys[y + 1], ys[y] + 1); sy++) {
      let p = (sy * W + xs[x]) * 4;
      for (let sx = xs[x]; sx < Math.max(xs[x + 1], xs[x] + 1); sx++, p += 4) { r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** Spread of brightness inside a box: ~0 for a blank or solid fragment. */
function lumaSpread(data, W, r) {
  let n = 0, sum = 0, sq = 0;
  const step = Math.max(1, Math.round(Math.sqrt(((r.x1 - r.x0) * (r.y1 - r.y0)) / 4000)));
  for (let y = r.y0; y < r.y1; y += step) for (let x = r.x0; x < r.x1; x += step) {
    const p = (y * W + x) * 4, l = (data[p] * 3 + data[p + 1] * 6 + data[p + 2]) / 10;
    sum += l; sq += l * l; n++;
  }
  if (!n) return 0;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

function findPanels(img, minPanelArea, maxDepth) {
  const W = img.width, H = img.height;
  const whole = [{ x: 0, y: 0, w: W, h: H }];
  let ink = inkMask(img.data, W, H);
  if (!ink) return whole;
  despeckle(ink, W, H, Math.max(6, Math.round(W * H * 0.00004)));
  const angle = estimateSkew(ink, W, H);
  if (angle) ink = rotateMask(ink, W, H, angle);
  const boxes = xyCut(ink, W, H, maxDepth);
  const pageArea = W * H;
  const kept = boxes.filter((r) => ((r.x1 - r.x0) * (r.y1 - r.y0)) / pageArea >= minPanelArea && lumaSpread(img.data, W, r) >= 12);
  const clean = kept.filter((r) => edgeCoverage(ink, W, r) >= 0.55);
  const covered = kept.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0) / pageArea;
  if (clean.length < 2 || covered < 0.35) return whole;
  const pad = Math.max(1, Math.round(Math.max(W, H) * 0.004));
  return kept.map((r) => {
    let x0 = r.x0, y0 = r.y0, x1 = r.x1, y1 = r.y1;
    if (angle) {
      const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => unrotate(x, y, W, H, angle));
      x0 = Math.min(...pts.map((p) => p[0])); x1 = Math.max(...pts.map((p) => p[0]));
      y0 = Math.min(...pts.map((p) => p[1])); y1 = Math.max(...pts.map((p) => p[1]));
    }
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(W, Math.ceil(x1 + pad)); y1 = Math.min(H, Math.ceil(y1 + pad));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
}

// ───────────────────────── browser side ─────────────────────────

const FRIENDLY = {
  pdfOld: "This device can't read PDF books yet. Update it (iPhone/iPad iOS 16.4 or newer), or add photos of the pages instead.",
  pdfLocked: "This PDF is locked with a password. Open it, save a copy without the password, then add that copy.",
  pdfBroken: "That PDF couldn't be opened. It may be damaged. Try saving it again, or add photos of the pages instead.",
  pdfBig: "That PDF is too big (over 100 MB). Try a smaller copy, or add photos of the pages instead.",
  nothing: "Nothing to add. Choose a PDF, photos of the pages, or a .txt story.",
};

function kindOf(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === "text/plain" || name.endsWith(".txt")) return "text";
  if (type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/.test(name)) return "image";
  return null;
}
const isHeic = (file) => /\.(heic|heif)$/i.test(file?.name || "") || /image\/hei[cf]/i.test(file?.type || "");

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ||= import("../vendor/pdfjs/pdf.min.js").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;
    return lib;
  }).catch(() => { pdfjsPromise = null; throw new Error(FRIENDLY.pdfOld); });
  return pdfjsPromise;
}

function canvasBlob(canvas, type = "image/jpeg", q = JPEG_QUALITY) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("That page couldn't be saved as a picture."))), type, q));
}
function freeCanvas(c) { c.width = 0; c.height = 0; } // iOS keeps canvas memory until resized

async function bitmapOf(blob) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(blob); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
const dims = (bmp) => [bmp.width || bmp.naturalWidth, bmp.height || bmp.naturalHeight];
const closeBitmap = (bmp) => { try { bmp.close?.(); } catch { /* not a bitmap */ } };

function pdfErrorMessage(err) {
  const name = err?.name || "";
  if (name === "PasswordException") return FRIENDLY.pdfLocked;
  if (err?.message === FRIENDLY.pdfOld) return FRIENDLY.pdfOld;
  return FRIENDLY.pdfBroken;
}

function pageText(content) {
  let s = "";
  for (const it of content?.items || []) {
    if (typeof it.str !== "string") continue;
    s += it.str;
    if (it.hasEOL) s += "\n";
  }
  return normaliseText(s);
}

async function readPdf(file, ctx) {
  if (file.size > MAX_PDF_BYTES) throw new Error(FRIENDLY.pdfBig);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new Error(FRIENDLY.pdfBroken);
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: bytes,
    isEvalSupported: false, // never compile PDF functions to JS (CSP has no unsafe-eval anyway)
    useWasm: false, // CSP has no wasm-unsafe-eval; JPX/JBIG2/ICC fall back to JS or are skipped
    useSystemFonts: true, // standard 14 fonts come from the device, not from font files
    disableFontFace: false, // embedded fonts load through the FontFace API (no network)
    enableXfa: false,
    disableAutoFetch: true, disableStream: true, disableRange: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  let pdf;
  try { pdf = await task.promise; } catch (err) { task.destroy?.(); throw new Error(pdfErrorMessage(err)); }
  try {
    let title = "";
    try {
      const meta = await pdf.getMetadata();
      title = cleanTitle(meta?.metadata?.get?.("dc:title") || "") || cleanTitle(meta?.info?.Title || "");
    } catch { /* metadata is optional */ }
    const room = Math.max(0, MAX_PAGES - ctx.pages.length);
    const count = Math.min(pdf.numPages, room);
    if (pdf.numPages > count) ctx.warnings.push(`Only the first ${count} of ${pdf.numPages} pages of "${file.name}" were added (a book can have up to ${MAX_PAGES} pages).`);
    ctx.total += count - 1;
    let emptyText = 0;
    for (let n = 1; n <= count; n++) {
      ctx.progress(`Reading page ${n} of ${count}`);
      const page = await pdf.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        let scale = Math.min(PDF_MAX_SCALE, PDF_LONG_SIDE / Math.max(base.width, base.height));
        if (base.width * base.height * scale * scale > PDF_MAX_AREA) scale = Math.sqrt(PDF_MAX_AREA / (base.width * base.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        try {
          await page.render({ canvasContext: g, viewport: vp, background: "#ffffff" }).promise;
          // Fresh canvas → JPEG: no metadata from the PDF or its images survives.
          const blob = await canvasBlob(c);
          let text = "";
          try { text = pageText(await page.getTextContent()); } catch { /* no text layer */ }
          if (!text) emptyText++;
          ctx.pages.push({ blob, width: c.width, height: c.height, source: "pdf", text });
        } finally { freeCanvas(c); }
      } finally { page.cleanup(); }
      ctx.step();
    }
    if (!title) title = cleanTitle(file.name);
    return { title, scanned: count > 0 && emptyText === count };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

async function readImage(file, ctx) {
  ctx.progress(`Adding ${file.name || "picture"}`);
  let blob;
  try {
    const { bytes, mime } = await pagePhoto(file);
    blob = new Blob([bytes], { type: mime });
  } catch {
    ctx.warnings.push(isHeic(file)
      ? `"${file.name}" is an iPhone HEIC photo this browser can't open. On the iPhone, share it as a JPEG ("Most Compatible") and add it again.`
      : `"${file.name}" couldn't be opened as a picture, so it was skipped.`);
    ctx.step();
    return;
  }
  const bmp = await bitmapOf(blob);
  const [width, height] = dims(bmp);
  closeBitmap(bmp);
  ctx.pages.push({ blob, width, height, source: "image", text: "" });
  ctx.step();
}

async function readText(file, ctx) {
  ctx.progress(`Reading ${file.name || "story"}`);
  let raw = await file.slice(0, MAX_TEXT_BYTES).text();
  if (file.size > MAX_TEXT_BYTES) ctx.warnings.push(`"${file.name}" is very long, so only the start of it was used.`);
  if (/\u0000/.test(raw.slice(0, 4096))) { ctx.warnings.push(`"${file.name}" doesn't look like a plain-text story, so it was skipped.`); ctx.step(); return; }
  raw = cleanStoryText(raw);
  const t = ctx.texts.length ? null : titleFromText(raw);
  if (t) { ctx.textTitle = t.title; raw = t.rest; }
  if (raw) ctx.texts.push(raw);
  else ctx.warnings.push(`"${file.name}" is empty.`);
  ctx.step();
}

/**
 * Read a child's finished book from files the parent picked.
 * @param {FileList|File[]} files
 * @param {{ onProgress?: (p: {done:number,total:number,label:string}) => void }} [opts]
 * @returns {Promise<{ title: string, pages: {blob:Blob,width:number,height:number,source:"pdf"|"image"|"text",text:string}[], warnings: string[], storyText: string }>}
 */
export async function readBookFiles(files, { onProgress } = {}) {
  const list = Array.from(files || []).filter(Boolean);
  const warnings = [];
  const usable = [];
  for (const f of list) {
    const kind = kindOf(f);
    if (kind) usable.push({ f, kind });
    else warnings.push(`"${f.name}" isn't a PDF, picture or .txt story, so it was skipped.`);
  }
  usable.sort((a, b) => naturalCompare(a.f.name, b.f.name));
  const ctx = {
    pages: [], texts: [], warnings, done: 0, total: usable.length,
    progress(label) { try { onProgress?.({ done: ctx.done, total: Math.max(ctx.total, ctx.done), label }); } catch { /* UI callback */ } },
    step() { ctx.done++; },
  };
  let title = "", fallbackTitle = "", firstError = null, skipped = 0, scannedPdf = false;
  for (const { f, kind } of usable) {
    if (kind !== "text" && ctx.pages.length >= MAX_PAGES) { skipped++; ctx.step(); continue; }
    try {
      if (kind === "pdf") {
        ctx.progress(`Opening ${f.name || "PDF"}`);
        const r = await readPdf(f, ctx);
        title ||= r.title;
        scannedPdf ||= r.scanned;
      } else if (kind === "image") {
        await readImage(f, ctx);
      } else {
        await readText(f, ctx);
      }
      fallbackTitle ||= cleanTitle(f.name);
    } catch (err) {
      const msg = err?.message || FRIENDLY.pdfBroken;
      firstError ||= new Error(msg);
      warnings.push(list.length > 1 ? `"${f.name}": ${msg}` : msg);
      ctx.step();
    }
  }
  if (skipped) warnings.push(`${skipped} file${skipped === 1 ? " was" : "s were"} left out because a book can have up to ${MAX_PAGES} pages.`);
  const storyText = ctx.texts.join("\n\n");
  if (!ctx.pages.length && !storyText) {
    if (firstError) throw firstError;
    throw new Error(warnings.length ? warnings.join(" ") : FRIENDLY.nothing);
  }
  if (scannedPdf && !storyText) warnings.push("The PDF pages are pictures without typed text, so the words will need to be typed in (or read aloud from the pictures).");
  try { onProgress?.({ done: ctx.done, total: ctx.done, label: "Done" }); } catch { /* UI callback */ }
  return { title: title || ctx.textTitle || fallbackTitle, pages: ctx.pages, warnings, storyText };
}

/**
 * Cut a comic page picture into its panels.
 * @param {Blob} blob page picture (e.g. a page from readBookFiles)
 * @returns {Promise<{blob:Blob,x:number,y:number,w:number,h:number}[]>} boxes in the picture's
 *   own pixels, reading order. One item (the original blob, whole page) when no clean panels.
 */
export async function splitIntoPanels(blob, { minPanelArea = 0.06 } = {}) {
  const bmp = await bitmapOf(blob);
  const [W, H] = dims(bmp);
  try {
    // Read the picture at its own size (no canvas scaling); detectPanels downsamples it itself.
    const a = document.createElement("canvas"); a.width = W; a.height = H;
    const ag = a.getContext("2d", { willReadFrequently: true });
    ag.fillStyle = "#fff"; ag.fillRect(0, 0, W, H);
    ag.drawImage(bmp, 0, 0);
    const boxes = detectPanels(ag.getImageData(0, 0, W, H), { minPanelArea });
    freeCanvas(a);
    if (boxes.length < 2) return [{ blob, x: 0, y: 0, w: W, h: H }];
    const out = [];
    for (const b of boxes) {
      const { x, y, w, h } = b;
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
      g.drawImage(bmp, x, y, w, h, 0, 0, w, h);
      try { out.push({ blob: await canvasBlob(c), x, y, w, h }); } finally { freeCanvas(c); }
    }
    return out;
  } finally { closeBitmap(bmp); }
}
