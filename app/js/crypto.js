// The vault. A parent passcode is stretched (PBKDF2-SHA-256, 600k rounds) into a key that
// wraps one random AES-256-GCM data key. Every record and image is sealed with that data key,
// bound to its own id (AAD) so records can't be swapped or edited without detection.
// Pure WebCrypto: no storage, no DOM, so it is unit-tested in Node.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;
const VAULT_AAD = te.encode("wishcircle/vault/v1");

export const b64 = {
  enc(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  },
};

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const randomId = () => Array.from(randomBytes(16), (x) => x.toString(16).padStart(2, "0")).join("");

const COMMON = new Set(["123456", "1234567", "12345678", "123456789", "password", "qwerty", "111111", "000000", "123123", "654321", "abcdef", "abc123", "iloveyou", "letmein", "passcode", "121212"]);
// Returns a message if the passcode is too weak, otherwise null.
export function passcodeProblem(p) {
  if (typeof p !== "string" || p.length < 6) return "Use at least 6 characters.";
  if (/^(.)\1+$/.test(p)) return "Don't repeat one character.";
  if (COMMON.has(p.toLowerCase())) return "That passcode is too easy to guess.";
  if (/^\d+$/.test(p)) {
    const d = [...p].map(Number);
    if (d.every((x, i) => i === 0 || x - d[i - 1] === 1) || d.every((x, i) => i === 0 || x - d[i - 1] === -1)) return "Avoid counting sequences like 123456.";
  }
  return null;
}

async function deriveKek(passcode, salt, iterations) {
  const base = await subtle.importKey("raw", te.encode(passcode.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"],
  );
}

async function wrap(dataKey, passcode, iterations) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const kek = await deriveKek(passcode, salt, iterations);
  const wrapped = await subtle.wrapKey("raw", dataKey, kek, { name: "AES-GCM", iv, additionalData: VAULT_AAD });
  return { v: 1, kdf: "PBKDF2-SHA-256", iterations, salt: b64.enc(salt), iv: b64.enc(iv), wrapped: b64.enc(wrapped) };
}

// New vault: returns the public metadata to store and a non-extractable key to use.
export async function createVault(passcode, iterations = PBKDF2_ITERATIONS) {
  const dataKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const meta = await wrap(dataKey, passcode, iterations);
  const key = await openVault(meta, passcode);
  return { meta, key };
}

// Wrong passcode → null (the GCM tag check fails). Right passcode → the data key.
export async function openVault(meta, passcode, extractable = false) {
  if (!meta || meta.v !== 1 || !(meta.iterations >= 1)) return null;
  const kek = await deriveKek(passcode, b64.dec(meta.salt), meta.iterations);
  try {
    return await subtle.unwrapKey(
      "raw", b64.dec(meta.wrapped), kek,
      { name: "AES-GCM", iv: b64.dec(meta.iv), additionalData: VAULT_AAD },
      { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"],
    );
  } catch {
    return null;
  }
}

// Same data key, new passcode. Nothing else needs re-encrypting.
export async function rewrapVault(meta, oldPass, newPass, iterations = meta.iterations) {
  const key = await openVault(meta, oldPass, true);
  if (!key) return null;
  return wrap(key, newPass, iterations);
}

export async function seal(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, bytes);
  return { iv, ct: new Uint8Array(ct) };
}

export async function open(key, rec, aad) {
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: rec.iv, additionalData: te.encode(aad) }, key, rec.ct);
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

export const sealJSON = (key, obj, aad) => seal(key, te.encode(JSON.stringify(obj)), aad);
export async function openJSON(key, rec, aad) {
  const b = await open(key, rec, aad);
  if (!b) return null;
  try { return JSON.parse(td.decode(b)); } catch { return null; }
}

// Slow-hash a child's picture lock. Only keeps siblings apart inside an unlocked app;
// the real protection is the parent passcode above.
export async function hashPicLock(seq, saltB64) {
  const salt = saltB64 ? b64.dec(saltB64) : randomBytes(16);
  const base = await subtle.importKey("raw", te.encode(seq.join("|")), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, base, 256);
  return { salt: b64.enc(salt), hash: b64.enc(bits) };
}
