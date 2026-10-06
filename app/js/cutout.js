// Character cut-outs from painted comic panels, on the device, with no libraries.
//
// Given a box around a character (from the AI reading the comic, or a person), we run a
// GrabCut-style segmentation (Rother, Kolmogorov & Blake 2004) on a ≤300 px copy of the box:
//   1. colour models: two 5-component full-covariance Gaussian mixtures in RGB; the character's
//      seeded from the middle of the box, the scenery's from a ring around the box plus a thin
//      band just inside it (k-means seeding, deterministic);
//   2. a graph cut (Boykov–Kolmogorov max-flow, 8-connected grid) balancing "which model fits
//      this colour" against "don't cut between similar neighbours" (contrast-sensitive Potts);
//   3. refit both models to the new labels and cut again (3 rounds).
// Comic-specific clean-up then: pixels along the picture's own border are scenery (panel frames);
// touching pixels that clearly fit the character model are won back (graph cuts shave thin
// parts); long thin dark lines hanging off the cut (frames, captions) are dropped and a short dark
// ink rim is pulled back in; small specks go, big pieces stay, a separate blob of character colour
// that a short ink path joins to the body (a tail's tuft) is reconnected; small holes are filled;
// the edge is feathered by about a pixel. Optional "keep"/"remove" brush strokes are hard
// constraints. autoCutRGBA/autoCutCast add box fixing (widen; push out sides the character runs
// into, but only if the wider cut agrees with the narrow one) and a quality score for choosing
// between appearances or giving up (the game then keeps its emoji).
//
// Everything except decodeBlob/encodePNG is pure and works on typed arrays (tested in Node). No
// DOM is needed when OffscreenCanvas exists, so this module also runs inside a module Worker.

export const WORK_SIDE = 300; // long side of the box when segmenting (speed vs. detail)
export const OUT_SIDE = 512; // long side of the finished sprite
const K = 5; // mixture components per model
const GAMMA = 50; // smoothness weight (GrabCut's usual value)
const HARD = 1e9; // capacity for a hard constraint
const ROUNDS = 3; // model ↔ cut rounds (more changes little on comics)
export const TUNE = { grow: 2, steps: 6, gamma: GAMMA, ring: 0.12, ell: 0.5, frame: 0.02, thin: 2, bridge: 0.25 };

// ───────────────────────── max-flow / min-cut on a grid ─────────────────────────

// 8 directions; opposite(d) = d ^ 1.
const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DY = [0, 0, 1, -1, 1, -1, -1, 1];
const TERM = 8, ORPHAN = 9, NONE = -1;

/**
 * Boykov–Kolmogorov max-flow on a W×H grid with 8-neighbour arcs.
 * cap: Float64Array(W*H*8): capacity of the arc from pixel i towards direction d (index i*8+d);
 *      arcs leaving the grid are ignored. src/snk: Float64Array(W*H) terminal capacities.
 * Returns { flow, fg: Uint8Array } where fg[i] = 1 when pixel i ends on the source side.
 * The inputs are not modified.
 */
export function maxflowGrid(W, H, cap, src, snk) {
  const PW = W + 2, PH = H + 2, N = PW * PH;
  const off = DX.map((dx, d) => dx + DY[d] * PW);
  const rc = new Float64Array(N * 8); // residual capacities on the padded grid
  const tr = new Float64Array(N); // >0: residual from the source, <0: residual to the sink
  let flow = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = (y + 1) * PW + x + 1;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) rc[p * 8 + d] = cap[i * 8 + d];
      }
      const s = src[i], t = snk[i];
      flow += Math.min(s, t);
      tr[p] = s - t;
    }
  }
  const tree = new Uint8Array(N); // 0 free, 1 source tree, 2 sink tree
  const par = new Int8Array(N).fill(NONE);
  const ts = new Int32Array(N), dist = new Int32Array(N);
  const queue = new Int32Array(N + 1), inQ = new Uint8Array(N);
  let qh = 0, qt = 0;
  const qlen = N + 1;
  const push = (v) => { if (!inQ[v]) { inQ[v] = 1; queue[qt] = v; qt = qt + 1 === qlen ? 0 : qt + 1; } };
  const pop = () => { if (qh === qt) return -1; const v = queue[qh]; qh = qh + 1 === qlen ? 0 : qh + 1; inQ[v] = 0; return v; };
  for (let p = 0; p < N; p++) {
    if (tr[p] > 0) { tree[p] = 1; par[p] = TERM; dist[p] = 1; push(p); }
    else if (tr[p] < 0) { tree[p] = 2; par[p] = TERM; dist[p] = 1; push(p); }
  }
  const orphans = [];
  let time = 0, cur = -1;

  for (;;) {
    if (cur < 0 || tree[cur] === 0) {
      cur = pop();
      if (cur < 0) break;
      if (tree[cur] === 0) { cur = -1; continue; }
    }
    // ---- growth ----
    let s = -1, sd = -1;
    const t0 = tree[cur];
    for (let d = 0; d < 8; d++) {
      const q = cur + off[d];
      if (t0 === 1) {
        if (rc[cur * 8 + d] <= 0) continue;
        if (tree[q] === 0) { tree[q] = 1; par[q] = d ^ 1; ts[q] = ts[cur]; dist[q] = dist[cur] + 1; push(q); }
        else if (tree[q] === 2) { s = cur; sd = d; break; }
        else if (ts[q] <= ts[cur] && dist[q] > dist[cur]) { par[q] = d ^ 1; ts[q] = ts[cur]; dist[q] = dist[cur] + 1; }
      } else {
        if (rc[q * 8 + (d ^ 1)] <= 0) continue;
        if (tree[q] === 0) { tree[q] = 2; par[q] = d ^ 1; ts[q] = ts[cur]; dist[q] = dist[cur] + 1; push(q); }
        else if (tree[q] === 1) { s = q; sd = d ^ 1; break; }
        else if (ts[q] <= ts[cur] && dist[q] > dist[cur]) { par[q] = d ^ 1; ts[q] = ts[cur]; dist[q] = dist[cur] + 1; }
      }
    }
    if (s < 0) { cur = -1; continue; }
    time++;
    // ---- augment along source…s → t…sink ----
    const t = s + off[sd];
    let f = rc[s * 8 + sd];
    for (let x = s; ; ) {
      const d = par[x];
      if (d === TERM) { if (tr[x] < f) f = tr[x]; break; }
      const pp = x + off[d];
      const c = rc[pp * 8 + (d ^ 1)];
      if (c < f) f = c;
      x = pp;
    }
    for (let x = t; ; ) {
      const d = par[x];
      if (d === TERM) { if (-tr[x] < f) f = -tr[x]; break; }
      const c = rc[x * 8 + d];
      if (c < f) f = c;
      x = x + off[d];
    }
    rc[s * 8 + sd] -= f; rc[t * 8 + (sd ^ 1)] += f;
    for (let x = s; ; ) {
      const d = par[x];
      if (d === TERM) { tr[x] -= f; if (tr[x] <= 0) { tr[x] = 0; par[x] = ORPHAN; orphans.push(x); } break; }
      const pp = x + off[d];
      rc[pp * 8 + (d ^ 1)] -= f; rc[x * 8 + d] += f;
      if (rc[pp * 8 + (d ^ 1)] <= 0) { par[x] = ORPHAN; orphans.push(x); }
      x = pp;
    }
    for (let x = t; ; ) {
      const d = par[x];
      if (d === TERM) { tr[x] += f; if (tr[x] >= 0) { tr[x] = 0; par[x] = ORPHAN; orphans.push(x); } break; }
      const pp = x + off[d];
      rc[x * 8 + d] -= f; rc[pp * 8 + (d ^ 1)] += f;
      if (rc[x * 8 + d] <= 0) { par[x] = ORPHAN; orphans.push(x); }
      x = pp;
    }
    flow += f;
    // ---- adoption ----
    while (orphans.length) {
      const o = orphans.pop();
      const to = tree[o];
      let best = -1, bestD = 1 << 30;
      for (let d = 0; d < 8; d++) {
        const q = o + off[d];
        if (tree[q] !== to) continue;
        if (to === 1 ? rc[q * 8 + (d ^ 1)] <= 0 : rc[o * 8 + d] <= 0) continue;
        // Does q still lead back to a terminal?
        let dd = 0, x = q;
        for (;;) {
          if (ts[x] === time) { dd += dist[x]; break; }
          const pd = par[x];
          dd++;
          if (pd === TERM) { ts[x] = time; dist[x] = 1; break; }
          if (pd === ORPHAN || pd === NONE) { dd = 1 << 30; break; }
          x += off[pd];
        }
        if (dd < 1 << 30) {
          if (dd < bestD) { best = d; bestD = dd; }
          for (let y = q; ts[y] !== time; y += off[par[y]]) { ts[y] = time; dist[y] = dd--; }
        }
      }
      if (best >= 0) { par[o] = best; ts[o] = time; dist[o] = bestD + 1; continue; }
      for (let d = 0; d < 8; d++) {
        const q = o + off[d];
        if (tree[q] !== to) continue;
        if (to === 1 ? rc[q * 8 + (d ^ 1)] > 0 : rc[o * 8 + d] > 0) push(q);
        if (par[q] === (d ^ 1)) { par[q] = ORPHAN; orphans.push(q); }
      }
      tree[o] = 0; par[o] = NONE;
    }
  }
  const fg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fg[y * W + x] = tree[(y + 1) * PW + x + 1] === 1 ? 1 : 0;
  return { flow, fg };
}

// ───────────────────────── Gaussian mixtures (RGB) ─────────────────────────

// Deterministic k-means (k-means++ seeding with a fixed LCG) → component index per sample.
export function kmeans(pix, idx, k = K, rounds = 8) {
  const n = idx.length;
  const comp = new Uint8Array(n);
  if (!n) return comp;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  // subsample for seeding/refinement speed
  const step = Math.max(1, Math.floor(n / 6000));
  const sub = [];
  for (let i = 0; i < n; i += step) sub.push(idx[i]);
  const C = new Float64Array(k * 3);
  let first = sub[Math.floor(rnd() * sub.length)];
  C[0] = pix[first * 3]; C[1] = pix[first * 3 + 1]; C[2] = pix[first * 3 + 2];
  const d2 = new Float64Array(sub.length).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let j = 0; j < sub.length; j++) {
      const p = sub[j] * 3;
      const a = pix[p] - C[(c - 1) * 3], b = pix[p + 1] - C[(c - 1) * 3 + 1], e = pix[p + 2] - C[(c - 1) * 3 + 2];
      const v = a * a + b * b + e * e;
      if (v < d2[j]) d2[j] = v;
      sum += d2[j];
    }
    let r = rnd() * sum, pick = sub[sub.length - 1];
    for (let j = 0; j < sub.length; j++) { r -= d2[j]; if (r <= 0) { pick = sub[j]; break; } }
    C[c * 3] = pix[pick * 3]; C[c * 3 + 1] = pix[pick * 3 + 1]; C[c * 3 + 2] = pix[pick * 3 + 2];
  }
  const S = new Float64Array(k * 4);
  const nearest = (p) => {
    let bi = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const a = pix[p] - C[c * 3], b = pix[p + 1] - C[c * 3 + 1], e = pix[p + 2] - C[c * 3 + 2];
      const v = a * a + b * b + e * e;
      if (v < bd) { bd = v; bi = c; }
    }
    return bi;
  };
  for (let it = 0; it < rounds; it++) {
    S.fill(0);
    for (let j = 0; j < sub.length; j++) {
      const p = sub[j] * 3, c = nearest(p);
      S[c * 4] += pix[p]; S[c * 4 + 1] += pix[p + 1]; S[c * 4 + 2] += pix[p + 2]; S[c * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) if (S[c * 4 + 3]) for (let q = 0; q < 3; q++) C[c * 3 + q] = S[c * 4 + q] / S[c * 4 + 3];
  }
  for (let i = 0; i < n; i++) comp[i] = nearest(idx[i] * 3);
  return comp;
}

/** Fit a k-component full-covariance Gaussian mixture to samples idx (with component labels). */
export function fitGMM(pix, idx, comp, k = K) {
  const S = new Float64Array(k * 10); // n, sum r g b, sum rr rg rb gg gb bb
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i] * 3, c = comp[i] * 10;
    const r = pix[p], g = pix[p + 1], b = pix[p + 2];
    S[c]++; S[c + 1] += r; S[c + 2] += g; S[c + 3] += b;
    S[c + 4] += r * r; S[c + 5] += r * g; S[c + 6] += r * b; S[c + 7] += g * g; S[c + 8] += g * b; S[c + 9] += b * b;
  }
  const total = idx.length || 1;
  const m = { k: 0, w: [], mean: [], inv: [], logc: [] };
  for (let c = 0; c < k; c++) {
    const o = c * 10, n = S[o];
    if (n < 4) continue;
    const mr = S[o + 1] / n, mg = S[o + 2] / n, mb = S[o + 3] / n;
    const reg = 6; // variance floor: crayon/pencil texture and JPEG noise
    const a = S[o + 4] / n - mr * mr + reg, bb = S[o + 5] / n - mr * mg, cc = S[o + 6] / n - mr * mb;
    const dd = S[o + 7] / n - mg * mg + reg, ee = S[o + 8] / n - mg * mb, ff = S[o + 9] / n - mb * mb + reg;
    // inverse of symmetric [[a,bb,cc],[bb,dd,ee],[cc,ee,ff]]
    const A = dd * ff - ee * ee, B = -(bb * ff - cc * ee), C = bb * ee - cc * dd;
    const det = a * A + bb * B + cc * C;
    if (!(det > 1e-6)) continue;
    const D = a * ff - cc * cc, E = -(a * ee - bb * cc), F = a * dd - bb * bb;
    m.w.push(n / total);
    m.mean.push(mr, mg, mb);
    m.inv.push(A / det, B / det, C / det, D / det, E / det, F / det); // xx xy xz yy yz zz
    m.logc.push(Math.log(n / total) - 0.5 * Math.log(det) - 2.756815599614018); // −1.5·ln(2π)
    m.k++;
  }
  return m;
}

// log of each weighted component density; returns best component and log-sum.
function evalGMM(m, r, g, b, out) {
  let best = 0, bestv = -Infinity, sum = 0;
  for (let c = 0; c < m.k; c++) {
    const x = r - m.mean[c * 3], y = g - m.mean[c * 3 + 1], z = b - m.mean[c * 3 + 2];
    const v = m.inv, o = c * 6;
    const q = v[o] * x * x + 2 * v[o + 1] * x * y + 2 * v[o + 2] * x * z + v[o + 3] * y * y + 2 * v[o + 4] * y * z + v[o + 5] * z * z;
    const l = m.logc[c] - 0.5 * q;
    if (l > bestv) { bestv = l; best = c; }
    sum += Math.exp(l);
  }
  out[0] = best;
  out[1] = sum > 1e-300 ? Math.log(sum) : bestv; // keep a finite value far out in the tails
}

// ───────────────────────── image helpers ─────────────────────────

/** Area-average a source rectangle (fractional coords) of an RGBA image into an ow×oh RGB float array. */
export function resampleRGB(rgba, W, H, sx, sy, sw, sh, ow, oh) {
  const out = new Float32Array(ow * oh * 3);
  const fx = sw / ow, fy = sh / oh;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = sy + oy * fy, y1 = y0 + fy;
    for (let ox = 0; ox < ow; ox++) {
      const x0 = sx + ox * fx, x1 = x0 + fx;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy, p = (y * W + x) * 4;
          r += rgba[p] * wgt; g += rgba[p + 1] * wgt; b += rgba[p + 2] * wgt; wsum += wgt;
        }
      }
      const o = (oy * ow + ox) * 3;
      if (wsum > 0) { out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; }
    }
  }
  return out;
}

/** 8-connected components of mask==val; returns { lab: Int32Array (0 = none), sizes: [0, n1, n2…], touches: [] } */
export function components(mask, w, h, val = 1) {
  const lab = new Int32Array(w * h);
  const sizes = [0], touches = [false];
  const stack = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== val || lab[i]) continue;
    n++;
    let sp = 0, size = 0, edge = false;
    stack[sp++] = i; lab[i] = n;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] === val && !lab[q]) { lab[q] = n; stack[sp++] = q; }
      }
    }
    sizes.push(size); touches.push(edge);
  }
  return { lab, sizes, touches };
}

function dilateInto(mask, w, h, allow) {
  const out = mask.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] || !allow[i]) continue;
    if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) out[i] = 1;
  }
  return out;
}
function erode(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    out[i] = mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w] ? 1 : 0;
  }
  return out;
}
const dilate = (mask, w, h) => dilateInto(mask, w, h, new Uint8Array(w * h).fill(1));

// ───────────────────────── segmentation ─────────────────────────

/**
 * Segment the character inside rect (image pixels) of an RGBA image.
 * strokes: [{x, y, r, keep}] in image pixels. Returns the work-resolution mask and its geometry:
 * { mask: Uint8Array(gw*gh), gw, gh, ox, oy, scale } — work pixel (u,v) covers image pixels
 * [ox + u/scale, ox + (u+1)/scale).
 */
export function segment(rgba, W, H, rect, { strokes = [], workSide = TUNE.work || WORK_SIDE, rounds = TUNE.rounds || ROUNDS, debug = false } = {}) {
  // The box, grown to take in any "keep" strokes, clipped to the image.
  let bx0 = rect.x, by0 = rect.y, bx1 = rect.x + rect.w, by1 = rect.y + rect.h;
  for (const s of strokes) if (s.keep) {
    bx0 = Math.min(bx0, s.x - s.r); by0 = Math.min(by0, s.y - s.r);
    bx1 = Math.max(bx1, s.x + s.r); by1 = Math.max(by1, s.y + s.r);
  }
  bx0 = Math.max(0, Math.floor(bx0)); by0 = Math.max(0, Math.floor(by0));
  bx1 = Math.min(W, Math.ceil(bx1)); by1 = Math.min(H, Math.ceil(by1));
  const bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);
  const scale = Math.min(1, workSide / Math.max(bw, bh));
  // A ring of scenery around the box teaches the background model.
  const ring = Math.max(6, Math.round(TUNE.ring * Math.max(bw, bh)));
  const ox = Math.max(0, bx0 - ring), oy = Math.max(0, by0 - ring);
  const ex = Math.min(W, bx1 + ring), ey = Math.min(H, by1 + ring);
  const gw = Math.max(1, Math.round((ex - ox) * scale)), gh = Math.max(1, Math.round((ey - oy) * scale));
  const sx = (ex - ox) / gw, sy = (ey - oy) / gh; // image px per work px
  const pix = resampleRGB(rgba, W, H, ox, oy, ex - ox, ey - oy, gw, gh);
  const n = gw * gh;

  // Region codes: 0 = outside the box (background), 1 = inside (unknown), 2 = keep, 3 = remove.
  const region = new Uint8Array(n);
  const u0 = Math.max(0, Math.round((bx0 - ox) / sx)), v0 = Math.max(0, Math.round((by0 - oy) / sy));
  const u1 = Math.min(gw, Math.round((bx1 - ox) / sx)), v1 = Math.min(gh, Math.round((by1 - oy) / sy));
  // Inside the child's original box (not the stroke-grown one).
  const r0 = Math.round((rect.x - ox) / sx), s0 = Math.round((rect.y - oy) / sy);
  const r1 = Math.round((rect.x + rect.w - ox) / sx), s1 = Math.round((rect.y + rect.h - oy) / sy);
  for (let v = v0; v < v1; v++) for (let u = u0; u < u1; u++) if (u >= r0 && u < r1 && v >= s0 && v < s1) region[v * gw + u] = 1;
  // Panel pictures carry their black frame along the edges: a thin band at the picture's own
  // border is scenery, even when the box reaches it.
  const edgePx = Math.max(1, Math.round((TUNE.frame * Math.max(W, H)) / sx));
  for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) {
    const i = v * gw + u;
    if (region[i] !== 1) continue;
    if ((ox === 0 && u < edgePx) || (oy === 0 && v < edgePx) || (ex >= W && u >= gw - edgePx) || (ey >= H && v >= gh - edgePx)) region[i] = 0;
  }
  for (const s of strokes) {
    const cu = (s.x - ox) / sx, cv = (s.y - oy) / sy, rr = Math.max(1, s.r / sx);
    for (let v = Math.max(0, Math.floor(cv - rr)); v <= Math.min(gh - 1, Math.ceil(cv + rr)); v++) {
      for (let u = Math.max(0, Math.floor(cu - rr)); u <= Math.min(gw - 1, Math.ceil(cu + rr)); u++) {
        const du = u + 0.5 - cu, dv = v + 0.5 - cv;
        if (du * du + dv * dv <= rr * rr) region[v * gw + u] = s.keep ? 2 : 3;
      }
    }
  }
  // Grid for the cut = the grown box; everything else is fixed background.
  const cw = u1 - u0, ch = v1 - v0;

  // Pairwise weights (contrast-sensitive Potts), shared by every round.
  let beta = 0, cnt = 0;
  for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) {
    const p = (v * gw + u) * 3;
    if (u + 1 < gw) { const a = pix[p] - pix[p + 3], b = pix[p + 1] - pix[p + 4], c = pix[p + 2] - pix[p + 5]; beta += a * a + b * b + c * c; cnt++; }
    if (v + 1 < gh) { const q = p + gw * 3; const a = pix[p] - pix[q], b = pix[p + 1] - pix[q + 1], c = pix[p + 2] - pix[q + 2]; beta += a * a + b * b + c * c; cnt++; }
  }
  beta = beta > 0 ? cnt / (2 * beta) : 0;
  const cap = new Float64Array(cw * ch * 8);
  const edgeBg = new Float64Array(cw * ch); // pull towards background from fixed neighbours
  for (let v = 0; v < ch; v++) for (let u = 0; u < cw; u++) {
    const gi = (v + v0) * gw + u + u0, ci = v * cw + u;
    for (let d = 0; d < 8; d++) {
      const nu = u + u0 + DX[d], nv = v + v0 + DY[d];
      if (nu < 0 || nv < 0 || nu >= gw || nv >= gh) continue;
      const gj = nv * gw + nu, p = gi * 3, q = gj * 3;
      const a = pix[p] - pix[q], b = pix[p + 1] - pix[q + 1], c = pix[p + 2] - pix[q + 2];
      const wgt = (d < 4 ? TUNE.gamma : TUNE.gamma / Math.SQRT2) * Math.exp(-beta * (a * a + b * b + c * c));
      if (nu >= u0 && nv >= v0 && nu < u1 && nv < v1) cap[ci * 8 + d] = wgt;
      else edgeBg[ci] += wgt; // the neighbour is fixed scenery
    }
  }

  // Initial labels: character = middle of the box (an ellipse), scenery = outside + inner band.
  const lab = new Uint8Array(n);
  const band = Math.max(2, Math.round(0.05 * Math.max(r1 - r0, s1 - s0)));
  const cx = (r0 + r1) / 2, cy = (s0 + s1) / 2, ax = Math.max(1, (r1 - r0) / 2 - band), ay = Math.max(1, (s1 - s0) / 2 - band);
  const fgIdx = [], bgIdx = [];
  for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) {
    const i = v * gw + u, r = region[i];
    if (r === 2) { lab[i] = 1; fgIdx.push(i); continue; }
    if (r === 0 || r === 3) { bgIdx.push(i); continue; }
    const du = (u + 0.5 - cx) / ax, dv = (v + 0.5 - cy) / ay;
    const e = du * du + dv * dv;
    lab[i] = 1;
    if (e <= TUNE.ell) fgIdx.push(i);
    else if (u < r0 + band || u >= r1 - band || v < s0 + band || v >= s1 - band) bgIdx.push(i);
  }
  let fgComp = kmeans(pix, fgIdx), bgComp = kmeans(pix, bgIdx);
  let fgM = fitGMM(pix, fgIdx, fgComp), bgM = fitGMM(pix, bgIdx, bgComp);

  const src = new Float64Array(cw * ch), snk = new Float64Array(cw * ch);
  const llr = new Float32Array(n); // log p_fg − log p_bg from the last round
  const tmp = [0, 0];
  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      // Refit both models to the current labels (each pixel to its best component).
      const fi = [], bi = [], fc = [], bc = [];
      for (let i = 0; i < n; i++) {
        const p = i * 3;
        if (lab[i]) { evalGMM(fgM, pix[p], pix[p + 1], pix[p + 2], tmp); fi.push(i); fc.push(tmp[0]); }
        else { evalGMM(bgM, pix[p], pix[p + 1], pix[p + 2], tmp); bi.push(i); bc.push(tmp[0]); }
      }
      const f2 = fitGMM(pix, fi, fc), b2 = fitGMM(pix, bi, bc);
      if (f2.k) fgM = f2;
      if (b2.k) bgM = b2;
    }
    for (let v = 0; v < ch; v++) for (let u = 0; u < cw; u++) {
      const gi = (v + v0) * gw + u + u0, ci = v * cw + u, r = region[gi], p = gi * 3;
      if (r === 2) { src[ci] = HARD; snk[ci] = 0; continue; }
      if (r === 0 || r === 3) { src[ci] = 0; snk[ci] = HARD; continue; }
      evalGMM(fgM, pix[p], pix[p + 1], pix[p + 2], tmp); const lf = tmp[1];
      evalGMM(bgM, pix[p], pix[p + 1], pix[p + 2], tmp); const lb = tmp[1];
      // cost(FG) = −log p_fg, cost(BG) = −log p_bg; only the difference matters.
      llr[gi] = lf - lb;
      const dFg = -lf, dBg = -lb, m = Math.min(dFg, dBg);
      src[ci] = dBg - m; snk[ci] = dFg - m + edgeBg[ci];
    }
    const { fg } = maxflowGrid(cw, ch, cap, src, snk);
    let changed = 0;
    for (let v = 0; v < ch; v++) for (let u = 0; u < cw; u++) {
      const gi = (v + v0) * gw + u + u0, val = fg[v * cw + u];
      if (lab[gi] !== val) { lab[gi] = val; changed++; }
    }
    for (let i = 0; i < n; i++) if (region[i] === 0 || region[i] === 3) lab[i] = 0;
    if (round > 1 && changed < 0.001 * cw * ch) break;
  }

  // Graph cuts shave off thin parts (tails, legs, whiskers). Win them back: grow the cut into
  // touching pixels whose colour clearly belongs to the character's model.
  let grown = lab;
  const likely = new Uint8Array(n);
  for (let i = 0; i < n; i++) likely[i] = region[i] === 1 && llr[i] > TUNE.grow ? 1 : 0;
  for (let k = 0; k < TUNE.steps; k++) grown = dilateInto(grown, gw, gh, likely);
  const mask = cleanMask(grown, pix, gw, gh, region, llr);
  // Quality signals for choosing between cuts (see scoreCut).
  const side = (fn, len) => { let c = 0; for (let t = 0; t < len; t++) c += fn(t); return len ? c / len : 0; };
  const at = (u, v) => (u >= 0 && v >= 0 && u < gw && v < gh ? mask[v * gw + u] : 0);
  // Measured a few pixels inside the box: the cut itself tends to peel off the outermost row.
  const ins = Math.max(2, Math.round(0.02 * Math.max(r1 - r0, s1 - s0)));
  const touch = {
    left: rect.x <= 1 ? 0 : side((t) => at(r0 + ins, s0 + t), s1 - s0),
    right: rect.x + rect.w >= W - 1 ? 0 : side((t) => at(r1 - 1 - ins, s0 + t), s1 - s0),
    top: rect.y <= 1 ? 0 : side((t) => at(r0 + t, s0 + ins), r1 - r0),
    bottom: rect.y + rect.h >= H - 1 ? 0 : side((t) => at(r0 + t, s1 - 1 - ins), r1 - r0),
  };
  let area = 0, sure = 0, perim = 0;
  for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) {
    const i = v * gw + u;
    if (!mask[i]) continue;
    area++;
    if (llr[i] > 0 || region[i] === 2) sure++;
    if (!at(u - 1, v) || !at(u + 1, v) || !at(u, v - 1) || !at(u, v + 1)) perim++;
  }
  const stats = { area, boxArea: Math.max(1, (r1 - r0) * (s1 - s0)), sure: area ? sure / area : 0, perim, touch };
  const out = { mask, gw, gh, ox, oy, sx, sy, scale: 1 / sx, region, stats };
  if (debug) Object.assign(out, { raw: lab, llr, pix });
  return out;
}

// Comic clean-up of a raw cut (work resolution).
function cleanMask(lab, pix, w, h, region, llr) {
  const n = w * h;
  let m = lab.slice();
  // 1. The dark ink outline belongs to the character: grow into dark pixels touching the mask.
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * pix[i * 3] + 0.587 * pix[i * 3 + 1] + 0.114 * pix[i * 3 + 2];
  // "dark" relative to what's around the character: below 55% of the median brightness.
  const sorted = Float32Array.from(lum).sort();
  const dark = new Uint8Array(n);
  const thr = Math.min(110, sorted[n >> 1] * 0.55);
  for (let i = 0; i < n; i++) dark[i] = lum[i] < thr && region[i] !== 0 && region[i] !== 3 ? 1 : 0;
  // Long thin dark lines hanging off the cut are frames, captions or scenery outlines: drop mask
  // pixels that are dark and not inside a thick part, then give the body back a short ink rim.
  if (TUNE.thin) {
    let core = m;
    for (let k = 0; k < TUNE.thin; k++) core = erode(core, w, h);
    for (let k = 0; k < TUNE.thin + 1; k++) core = dilate(core, w, h);
    for (let i = 0; i < n; i++) if (m[i] && !core[i] && dark[i] && region[i] !== 2) m[i] = 0;
  }
  for (let k = 0; k < 3; k++) m = dilateInto(m, w, h, dark);
  // 2. Close (seal nicks). No opening: it would erase thin tails, legs and whiskers.
  const keepPx = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (region[i] === 2) keepPx[i] = 1;
  m = erode(dilate(m, w, h), w, h);
  for (let i = 0; i < n; i++) { if (keepPx[i]) m[i] = 1; if (region[i] === 0 || region[i] === 3) m[i] = 0; }
  // 3. Pieces: keep the biggest, any piece at least 25% of it, and pieces the child marked "keep".
  const { lab: cl, sizes } = components(m, w, h, 1);
  let big = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > big) big = sizes[c];
  const keepC = new Uint8Array(sizes.length);
  for (let c = 1; c < sizes.length; c++) if (sizes[c] >= 0.25 * big) keepC[c] = 1;
  for (let i = 0; i < n; i++) if (keepPx[i] && cl[i]) keepC[cl[i]] = 1;
  // Thin limbs (a tail with a tuft, a raised arm) often come out as a separate blob of character
  // colour with the thin, mostly-ink part between lost. Reconnect such a blob when a short path of
  // ink or not-clearly-scenery pixels leads back to the body, and rebuild that path as a limb.
  if (TUNE.bridge && llr) {
    const llrSum = new Float64Array(sizes.length);
    for (let i = 0; i < n; i++) if (cl[i]) llrSum[cl[i]] += llr[i];
    const cand = new Uint8Array(sizes.length);
    let any = false;
    for (let c = 1; c < sizes.length; c++) {
      if (keepC[c] || sizes[c] < Math.max(6, 0.003 * big) || llrSum[c] / sizes[c] < 1) continue;
      cand[c] = 1; any = true;
    }
    if (any) {
      const allow = new Uint8Array(n);
      for (let i = 0; i < n; i++) allow[i] = region[i] !== 0 && region[i] !== 3 && (dark[i] || llr[i] > -1) ? 1 : 0;
      const prev = new Int32Array(n).fill(-1), depth = new Int32Array(n);
      let q = [];
      for (let i = 0; i < n; i++) if (cl[i] && keepC[cl[i]]) { prev[i] = i; q.push(i); }
      const maxD = Math.round(TUNE.bridge * Math.max(w, h));
      const path = new Uint8Array(n);
      for (let dpt = 0; dpt < maxD && q.length; dpt++) {
        const nq = [];
        for (const p of q) {
          const x = p % w, y = (p / w) | 0;
          for (let d = 0; d < 8; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const r = ny * w + nx;
            if (prev[r] >= 0 || !allow[r]) continue;
            prev[r] = p; depth[r] = dpt + 1;
            const c = cl[r];
            if (c && cand[c]) {
              keepC[c] = 1; cand[c] = 0;
              for (let t = p; prev[t] !== t; t = prev[t]) path[t] = 1;
              continue;
            }
            nq.push(r);
          }
        }
        q = nq;
      }
      // Thicken the path a little through ink and character-ish colour.
      const thick = new Uint8Array(n);
      for (let i = 0; i < n; i++) thick[i] = allow[i] && (dark[i] || llr[i] > 0) ? 1 : 0;
      let pm = path;
      for (let k = 0; k < 2; k++) pm = dilateInto(pm, w, h, thick);
      for (let i = 0; i < n; i++) if (pm[i]) { m[i] = 1; if (!cl[i]) cl[i] = -1; }
    }
  }
  let area = 0;
  for (let i = 0; i < n; i++) { m[i] = cl[i] === -1 || (cl[i] > 0 && keepC[cl[i]]) ? 1 : 0; area += m[i]; }
  // 4. Fill small enclosed holes (paint gaps, eye whites) but keep big ones (a snake's coil).
  const holes = components(m, w, h, 0);
  const holeMax = Math.max(12, 0.01 * area);
  for (let i = 0; i < n; i++) {
    const c = holes.lab[i];
    if (c && !holes.touches[c] && holes.sizes[c] <= holeMax && region[i] !== 3) m[i] = 1;
  }
  return m;
}

/**
 * Cut out the character: returns { rgba: Uint8ClampedArray, w, h, x, y } — a tight RGBA crop
 * (long side ≤ outSide) with a feathered alpha edge, and where it sits in the image (x, y in
 * image pixels, before scaling). Returns null when nothing was found.
 */
export function cutoutRGBA(rgba, W, H, rect, opts = {}) {
  const outSide = opts.outSide || OUT_SIDE;
  const seg = segment(rgba, W, H, rect, opts);
  const { mask, gw, gh, ox, oy, sx, sy } = seg;
  let minU = gw, minV = gh, maxU = -1, maxV = -1;
  for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) if (mask[v * gw + u]) {
    if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  if (maxU < 0) return null;
  // Soft mask at work resolution: 3×3 tent blur of the binary mask.
  const soft = new Float32Array(gw * gh);
  for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) {
    let s = 0, ws = 0;
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
      const uu = u + du, vv = v + dv;
      if (uu < 0 || vv < 0 || uu >= gw || vv >= gh) continue;
      const wt = (2 - Math.abs(du)) * (2 - Math.abs(dv));
      s += mask[vv * gw + uu] * wt; ws += wt;
    }
    soft[v * gw + u] = s / ws;
  }
  // Crop (image px) = mask bbox + a small margin.
  const marginPx = 2 * sx;
  const cx0 = Math.max(0, ox + minU * sx - marginPx), cy0 = Math.max(0, oy + minV * sy - marginPx);
  const cx1 = Math.min(W, ox + (maxU + 1) * sx + marginPx), cy1 = Math.min(H, oy + (maxV + 1) * sy + marginPx);
  const cwid = cx1 - cx0, chei = cy1 - cy0;
  seg.stats.longPx = Math.max(cwid, chei);
  const s = Math.min(1, outSide / Math.max(cwid, chei));
  const w = Math.max(1, Math.round(cwid * s)), h = Math.max(1, Math.round(chei * s));
  const rgb = resampleRGB(rgba, W, H, cx0, cy0, cwid, chei, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  const ratio = (1 / sx) > 0 ? (s * sx) : 1; // output px per work px
  const k = Math.max(1, (2 * ratio) / 1.5); // ≈ 1–1.5 px feather at output size
  for (let y = 0; y < h; y++) {
    const gy = (cy0 + (y + 0.5) / s - oy) / sy - 0.5;
    const v0 = Math.max(0, Math.min(gh - 1, Math.floor(gy))), v1 = Math.min(gh - 1, v0 + 1), fy = Math.max(0, Math.min(1, gy - v0));
    for (let x = 0; x < w; x++) {
      const gx = (cx0 + (x + 0.5) / s - ox) / sx - 0.5;
      const u0 = Math.max(0, Math.min(gw - 1, Math.floor(gx))), u1 = Math.min(gw - 1, u0 + 1), fx = Math.max(0, Math.min(1, gx - u0));
      const a = soft[v0 * gw + u0] * (1 - fx) * (1 - fy) + soft[v0 * gw + u1] * fx * (1 - fy) + soft[v1 * gw + u0] * (1 - fx) * fy + soft[v1 * gw + u1] * fx * fy;
      const al = Math.max(0, Math.min(1, (a - 0.5) * k + 0.5));
      const o = (y * w + x) * 4, p = (y * w + x) * 3;
      if (al > 0) { out[o] = rgb[p]; out[o + 1] = rgb[p + 1]; out[o + 2] = rgb[p + 2]; out[o + 3] = Math.round(al * 255); }
    }
  }
  return { rgba: out, w, h, x: cx0, y: cy0, scale: s, seg };
}

// ───────────────────────── browser glue ─────────────────────────

const decoded = new WeakMap(); // blob → Promise<{ data, width, height }>
function canvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}
async function decodeBlob(blob) {
  if (!decoded.has(blob)) {
    decoded.set(blob, (async () => {
      const bmp = await createImageBitmap(blob);
      const c = canvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      return ctx.getImageData(0, 0, c.width, c.height);
    })());
  }
  return decoded.get(blob);
}
/** Decoded size of a picture (for mapping screen coordinates). */
export async function imageSize(blob) { const d = await decodeBlob(blob); return { w: d.width, h: d.height }; }

async function encodePNG(rgba, w, h) {
  const c = canvas(w, h);
  c.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = c.convertToBlob ? await c.convertToBlob({ type: "image/png" })
    : await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Cut a character out of a comic panel picture.
 * blob: the panel (PNG/JPEG); rect: { x, y, w, h } in panel pixels; strokes: [{ x, y, r, keep }].
 * → { bytes: Uint8Array (PNG), mime: "image/png", w, h } or null if nothing was found.
 */
export async function cutCharacter(blob, rect, { strokes = [] } = {}) {
  const img = await decodeBlob(blob);
  const r = cutoutRGBA(img.data, img.width, img.height, rect, { strokes });
  if (!r) return null;
  return { bytes: await encodePNG(r.rgba, r.w, r.h), mime: "image/png", w: r.w, h: r.h };
}

// ───────────────────────── automatic cast cut-outs ─────────────────────────

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ramp = (v, a, b) => clamp01((v - a) / (b - a));

/**
 * How good does a cut look, 0–1? A clean character silhouette fills a fair part of its box,
 * doesn't run off the box edges, is mostly made of "character" colours and has a smooth outline.
 */
export function scoreCut(stats) {
  if (!stats || !stats.area) return 0;
  const fill = stats.area / stats.boxArea;
  // a fair part of the box: tiny specks or "the whole box" are not a character
  const fillScore = fill < 0.2 ? ramp(fill, 0.03, 0.2) : fill > 0.7 ? 1 - 0.8 * ramp(fill, 0.7, 0.97) : 1;
  // running off the box means the box clipped it (or it's scenery)
  const t = stats.touch, worst = Math.max(t.left, t.right, t.top, t.bottom);
  const touchScore = 1 - 0.9 * ramp(worst, 0.05, 0.6);
  // mostly made of colours the character model likes (not a scenery leak)
  const sureScore = ramp(stats.sure, 0.4, 0.95);
  // outline length against a circle of the same area: scenery leaks are very ragged
  const ragged = stats.perim / (2 * Math.sqrt(Math.PI * stats.area));
  const smoothScore = 1 - 0.6 * ramp(ragged, 3.5, 7);
  // a bigger appearance makes a sharper sprite
  const sizeScore = 0.6 + 0.4 * ramp(stats.longPx || 0, 60, 260);
  return fillScore * touchScore * (0.3 + 0.7 * sureScore) * smoothScore * sizeScore;
}

export const ACCEPT_SCORE = 0.3;
const GROW_PAD = 0.06; // AI boxes are loose or a bit off: widen them a little first
const EXPAND = 0.25; // a side the character runs into grows by this much of the box size
const TOUCH_EXPAND = 0.15;

/**
 * Cut with automatic box fixing: widen the box a little, and when the character runs into a
 * side of the box (the box clipped it), push that side out and cut again (twice at most).
 * rect in image pixels. → the best cutoutRGBA result plus { rect, score }, or null.
 */
export function autoCutRGBA(rgba, W, H, rect, opts = {}) {
  let r = padRect(rect, GROW_PAD, W, H);
  let best = null, prev = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cut = cutoutRGBA(rgba, W, H, r, opts);
    if (!cut) break;
    // A wider box must add to the character, not change it (e.g. by flooding into the ground).
    if (prev && insideIoU(prev.seg, cut.seg, prev.rect) < 0.8) break;
    const score = scoreCut(cut.seg.stats);
    prev = { ...cut, rect: r, score };
    if (!best || score > best.score) best = prev;
    const t = cut.seg.stats.touch;
    if (opts.log) opts.log({ attempt, rect: r, score, stats: cut.seg.stats });
    const grow = { left: t.left > TOUCH_EXPAND, right: t.right > TOUCH_EXPAND, top: t.top > TOUCH_EXPAND, bottom: t.bottom > TOUCH_EXPAND };
    if (!grow.left && !grow.right && !grow.top && !grow.bottom) break;
    const nx0 = grow.left ? r.x - EXPAND * r.w : r.x, ny0 = grow.top ? r.y - EXPAND * r.h : r.y;
    const nx1 = grow.right ? r.x + r.w + EXPAND * r.w : r.x + r.w, ny1 = grow.bottom ? r.y + r.h + EXPAND * r.h : r.y + r.h;
    const nr = clipRect({ x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 }, W, H);
    if (Math.abs(nr.w - r.w) < 2 && Math.abs(nr.h - r.h) < 2) break; // already at the picture's edges
    r = nr;
  }
  return best;
}
// IoU of two cuts' masks over a box (sampled on a grid, image coordinates).
function insideIoU(a, b, r) {
  const has = (sg, x, y) => {
    const u = Math.floor((x - sg.ox) / sg.sx), v = Math.floor((y - sg.oy) / sg.sy);
    return u >= 0 && v >= 0 && u < sg.gw && v < sg.gh && sg.mask[v * sg.gw + u] === 1;
  };
  let inter = 0, uni = 0;
  for (let j = 0; j < 48; j++) for (let i = 0; i < 48; i++) {
    const x = r.x + ((i + 0.5) / 48) * r.w, y = r.y + ((j + 0.5) / 48) * r.h;
    const p = has(a, x, y), q = has(b, x, y);
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
}
function clipRect(r, W, H) {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
function padRect(r, f, W, H) { return clipRect({ x: r.x - f * r.w, y: r.y - f * r.h, w: r.w * (1 + 2 * f), h: r.h * (1 + 2 * f) }, W, H); }

/** Normalised (0–1) panel box → pixel box. Values are clamped; a degenerate box gives null. */
export function toPixelRect(rect, W, H) {
  if (!rect) return null;
  const n = (v) => (Number.isFinite(+v) ? +v : NaN);
  let x = n(rect.x), y = n(rect.y), w = n(rect.w), h = n(rect.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const x0 = clamp01(x), y0 = clamp01(y), x1 = clamp01(x + w), y1 = clamp01(y + h);
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { x: x0 * W, y: y0 * H, w: (x1 - x0) * W, h: (y1 - y0) * H };
}

/**
 * Pick the best cut-out of one character from where it appears in the comic.
 * appearances: [{ blob, rect, panelIndex }]: rect is a normalised (0–1) box in that panel picture;
 * the first 3 are tried.
 * → { bytes, mime: "image/png", w, h, rect (the normalised box finally used), panelIndex, score } or null
 * when no cut looks like a clean character (the caller then keeps the emoji).
 */
export async function autoCutCast(appearances, { maxTries = 3, minScore = ACCEPT_SCORE } = {}) {
  let best = null;
  for (const a of (appearances || []).slice(0, maxTries)) {
    try {
      const img = await decodeBlob(a.blob);
      const px = toPixelRect(a.rect, img.width, img.height);
      if (!px) continue;
      const r = autoCutRGBA(img.data, img.width, img.height, px);
      if (r && (!best || r.score > best.score)) best = { r, a, W: img.width, H: img.height };
      if (best && best.r.score > 0.85) break; // good enough; save the phone some work
    } catch { /* unreadable picture: try the next appearance */ }
    await new Promise((res) => setTimeout(res, 0)); // let the page breathe between cuts
  }
  if (!best || best.r.score < minScore) return null;
  const { r, a, W, H } = best;
  return {
    bytes: await encodePNG(r.rgba, r.w, r.h), mime: "image/png", w: r.w, h: r.h,
    rect: { x: r.rect.x / W, y: r.rect.y / H, w: r.rect.w / W, h: r.rect.h / H },
    panelIndex: a.panelIndex, score: Math.round(r.score * 1000) / 1000,
  };
}
