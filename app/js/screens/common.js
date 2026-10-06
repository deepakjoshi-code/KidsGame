// Shared pieces for the screens: navigation registry, prefs, form fields, typed confirmations.
import { h, button, modal, toast } from "../ui.js";
import * as store from "../store.js";
import { AVATARS, COLORS } from "../catalog.js";

// main.js fills this in, so screens can move between each other without import cycles.
export const nav = {};
// In-memory session state (gone when the app closes or locks).
export const session = { profileId: null, wiping: false };

// UI preferences only (never user data). Keys start with "wc.".
export const prefs = {
  get(k, dflt) { try { const v = localStorage.getItem("wc." + k); return v === null ? dflt : v; } catch { return dflt; } },
  set(k, v) { try { localStorage.setItem("wc." + k, String(v)); } catch { /* private mode */ } },
  clearAll() {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("wc.")) localStorage.removeItem(k); } catch { /* ignore */ }
  },
};
export const AUTOLOCK_CHOICES = [5, 10, 30];
export function autolockMinutes() {
  const n = Number(prefs.get("autolock", 10));
  return AUTOLOCK_CHOICES.includes(n) ? n : 10;
}

let uid = 0;
export const fid = (p = "f") => `${p}-${++uid}`;

// <label> + control + optional hint, wired with for/id.
export function field(label, control, hint) {
  if (!control.id) control.id = fid();
  return h("div", { class: "field" },
    h("label", { class: "label", for: control.id }, label),
    control,
    hint ? h("span", { class: "hint" }, hint) : null);
}

export function screen(cls, ...children) {
  return h("main", { class: "screen " + (cls || "") }, children);
}

// Busy state for a button while an async job runs.
export async function busy(btn, label, fn) {
  const old = [...btn.childNodes];
  btn.disabled = true;
  btn.replaceChildren(h("span", { class: "busy" }, label));
  try { return await fn(); } finally {
    if (btn.isConnected) { btn.disabled = false; btn.replaceChildren(...old); }
  }
}

// Ask the grown-up to type a word before a destructive step.
export function typedConfirm({ title, body, word, yes = "Erase" }) {
  return new Promise((resolve) => {
    const input = h("input", { class: "input", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": `Type ${word} to confirm` });
    const go = button(yes, () => finish(true), "danger");
    go.disabled = true;
    input.addEventListener("input", () => { go.disabled = input.value.trim().toUpperCase() !== word; });
    let m;
    const finish = (v) => { if (v && go.disabled) return; m.close(); resolve(v); };
    m = modal(h("form", { class: "modal", role: "alertdialog", "aria-modal": "true", "aria-label": title, onsubmit: (e) => { e.preventDefault(); finish(true); } },
      h("h2", null, title),
      body instanceof Node ? body : h("p", null, body),
      h("p", null, "To be sure, type ", h("strong", null, word), " below."),
      input,
      h("div", { class: "row end" }, button("Cancel", () => finish(false), "ghost"), go)), () => finish(false));
    setTimeout(() => input.focus(), 30);
  });
}

// The parent-passcode check used by every gate: shows the lockout wait instead of "wrong".
export async function verifyGate(pass) {
  const wait = await store.lockoutRemaining();
  if (wait > 0) return `Too many wrong tries. Please wait ${formatWait(wait)}.`;
  const ok = await store.verify(pass);
  if (ok) return true;
  const wait2 = await store.lockoutRemaining();
  return wait2 > 0 ? `That's not it. Too many tries: please wait ${formatWait(wait2)}.` : "That's not the parent passcode.";
}
export function formatWait(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, "0")} min` : `${s} s`;
}

export async function eraseEverything() {
  const ok = await typedConfirm({
    title: "Erase everything?",
    body: "This deletes every child profile, book, drawing and photo on this device. It can't be undone. Backups you saved as files are not touched.",
    word: "ERASE",
    yes: "Erase everything",
  });
  if (!ok) return false;
  session.wiping = true;
  try { await store.wipeEverything(); } finally { session.wiping = false; }
  session.profileId = null;
  prefs.clearAll();
  toast("Everything was erased.");
  nav.start();
  return true;
}

// Profile basics form (name, age, avatar, colour). Returns { node, read() }.
export function profileFields(p = {}) {
  const name = h("input", { class: "input", value: p.name || "", maxlength: 30, autocomplete: "off", autocapitalize: "words", spellcheck: "false" });
  const ages = [["", "Not set"], ...Array.from({ length: 13 }, (_, i) => [String(i + 2), String(i + 2)])];
  const age = h("select", { class: "input" }, ages.map(([v, l]) => h("option", { value: v, selected: String(p.age || "") === v }, l)));
  // New profiles start on a picture and colour no other child has yet.
  const taken = p.id ? [] : (store.isUnlocked() ? store.list("profile") : []);
  let avatar = p.avatar || AVATARS.find((a) => !taken.some((t) => t.avatar === a)) || AVATARS[0];
  let color = p.color || COLORS[taken.length % COLORS.length];
  const avatarBtns = AVATARS.map((a) => h("button", { type: "button", class: "avatar-opt", "aria-label": "Picture " + a, "aria-pressed": String(a === avatar), onclick: () => { avatar = a; avatarBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === a))); }, dataset: { v: a } }, a));
  const swatches = COLORS.map((c) => {
    const b = h("button", { type: "button", class: "swatch", "aria-label": "Colour " + c, "aria-pressed": String(c === color), dataset: { v: c }, onclick: () => { color = c; swatches.forEach((s) => s.setAttribute("aria-pressed", String(s.dataset.v === c))); } });
    b.style.backgroundColor = c;
    return b;
  });
  const node = h("div", { class: "stack" },
    field("Child's first name or nickname", name),
    field("Age (optional)", age),
    h("div", { class: "field" }, h("span", { class: "label" }, "Pick a picture"), h("div", { class: "avatar-grid", role: "group", "aria-label": "Profile picture" }, avatarBtns)),
    h("div", { class: "field" }, h("span", { class: "label" }, "Pick a colour"), h("div", { class: "swatch-row", role: "group", "aria-label": "Profile colour" }, swatches)),
  );
  return {
    node, focus: name,
    read() {
      const n = name.value.trim().replace(/\s+/g, " ");
      if (!n) return { error: "Please type a name." };
      return { name: n, age: age.value ? Number(age.value) : null, avatar, color };
    },
  };
}

export function starsText(n) {
  n = Math.max(0, Math.floor(n || 0));
  if (!n) return "No stars yet";
  return n <= 5 ? "⭐".repeat(n) : `⭐ × ${n}`;
}

export function avatarBadge(p, cls = "avatar") {
  const el = h("span", { class: cls, "aria-hidden": "true" }, p.avatar || "🙂");
  if (p.color) el.style.backgroundColor = p.color;
  return el;
}

export const todayStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
