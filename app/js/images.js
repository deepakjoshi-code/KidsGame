// Photo and drawing intake. Every image is decoded and re-drawn on a canvas, which
// drops hidden metadata (GPS location, camera details) before anything is stored.

const MAX_PAGE = 1400;
const MAX_SPRITE = 512;
const MAX_BYTES = 25 * 1024 * 1024;

async function decode(file) {
  if (!file || file.size > MAX_BYTES || !/^image\//.test(file.type || "image/")) throw new Error("Please choose a photo or picture file.");
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch { throw new Error("That picture couldn't be opened."); } finally { URL.revokeObjectURL(url); }
  }
}
function fit(w, h, max) { const s = Math.min(1, max / Math.max(w, h)); return [Math.round(w * s), Math.round(h * s)]; }
function toBytes(canvas, type, q) {
  return new Promise((resolve, reject) => canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("encode"))), type, q));
}

// A photo of a book page → clean JPEG.
export async function pagePhoto(file) {
  const img = await decode(file);
  const [w, h] = fit(img.width, img.height, MAX_PAGE);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { bytes: await toBytes(c, "image/jpeg", 0.85), mime: "image/jpeg" };
}

// A drawing of a character on paper → transparent PNG sprite, cropped tight.
// Paper is removed by flood-filling light pixels inward from the edges.
export async function spriteFromDrawing(file) {
  const img = await decode(file);
  const [w, h] = fit(img.width, img.height, MAX_SPRITE);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  // Paper colour = brightest common edge colour.
  let r0 = 0, g0 = 0, b0 = 0, n = 0;
  for (let x = 0; x < w; x += 4) for (const y of [0, h - 1]) { const i = (y * w + x) * 4; r0 += px[i]; g0 += px[i + 1]; b0 += px[i + 2]; n++; }
  r0 /= n; g0 /= n; b0 /= n;
  const near = (i) => Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) < 90 || (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 190);
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    if (!near(p * 4)) continue;
    px[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 0) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX <= minX || maxY <= minY) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }
  ctx.putImageData(data, 0, 0);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement("canvas"); out.width = cw; out.height = ch;
  out.getContext("2d").drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return { bytes: await toBytes(out, "image/png"), mime: "image/png" };
}

// Load a stored image id into an <img> ready for canvas drawing.
export async function loadImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

// A data: URL from a shared book file → validated, re-encoded bytes.
export async function fromDataURL(dataURL, asSprite) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataURL || "");
  if (!m) throw new Error("bad image");
  const bin = atob(m[2]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const file = new Blob([u], { type: m[1] });
  if (asSprite) {
    const img = await decode(file);
    const [w, h] = fit(img.width, img.height, MAX_SPRITE);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return { bytes: await toBytes(c, "image/png"), mime: "image/png" };
  }
  return pagePhoto(file);
}
