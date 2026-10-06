// Tiny JPEG checks for incoming panels: is it a real baseline/progressive JPEG, and how big?
// Only the start of the file is decoded (the frame header sits near the top of a canvas-made
// JPEG), so a big request costs little CPU.

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** → { width, height } or null when it isn't a JPEG we can read. */
export function jpegSize(b64) {
  if (typeof b64 !== "string" || b64.length < 8 || b64.length % 4 !== 0 || !B64.test(b64)) return null;
  for (const chars of [65536, b64.length]) {
    const n = Math.min(b64.length, chars - (chars % 4));
    let bytes;
    try { bytes = decodeB64(b64.slice(0, n)); } catch { return null; }
    const r = scan(bytes);
    if (r === "bad") return null;
    if (r) return r;
    if (n === b64.length) return null;
  }
  return null;
}

function scan(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return "bad";
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return "bad";
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return "bad"; // image data before any frame header
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return "bad";
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null;
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return width > 0 && height > 0 ? { width, height } : "bad";
    }
    i += 2 + len;
  }
  return null; // need more bytes
}
