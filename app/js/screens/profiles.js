// "Who's reading today?" picker, the child's picture lock, and the profile editor used by grown-ups.
import { h, show, button, toast, askPasscode, topbar } from "../ui.js";
import * as store from "../store.js";
import { hashPicLock } from "../crypto.js";
import { LOCK_PICS } from "../catalog.js";
import { nav, session, screen, profileFields, typedConfirm, verifyGate, avatarBadge, busy } from "./common.js";

export function picker() {
  session.profileId = null;
  const kids = store.list("profile");
  const tiles = kids.map((p) => h("button", { type: "button", class: "tile", onclick: () => choose(p.id), "aria-label": p.name + (p.lock ? " (picture lock)" : "") },
    avatarBadge(p),
    h("span", { class: "name" }, p.name),
    p.lock ? h("span", { class: "badge" }, "🔐 picture lock") : null));
  tiles.push(h("button", { type: "button", class: "tile add", onclick: addChild },
    h("span", { class: "avatar", "aria-hidden": "true" }, "➕"),
    h("span", { class: "name" }, "Add child"),
    h("span", { class: "badge" }, "grown-ups")));
  show(
    topbar({ title: "", actions: [button("🔒 Lock", () => nav.lockNow(), "small ghost")] }),
    screen("",
      h("h1", { class: "who-title" }, kids.length ? "Who's reading today?" : "Add a reader to start"),
      h("div", { class: "tiles" }, tiles),
      h("div", { class: "row center picker-foot" },
        button("⚙️ Grown-ups", async () => { if (await askPasscode("Grown-ups only", verifyGate)) nav.parent(); }, "ghost")),
    ));
}

async function addChild() {
  if (!(await askPasscode("Add a child", verifyGate))) return;
  profileEditor(null, { onDone: () => picker(), title: "Add a child" });
}

function choose(id) {
  const p = store.get(id);
  if (!p) return picker();
  if (p.lock) picLockScreen(p);
  else { session.profileId = p.id; nav.shelf(p.id); }
}

// The child taps their 3 secret pictures in order.
let misses = 0, pausedUntil = 0;
function picLockScreen(p) {
  let seq = [];
  const slots = h("div", { class: "slots", "aria-hidden": "true" }, [0, 1, 2].map(() => h("span")));
  const msg = h("p", { class: "center-text", role: "status", "aria-live": "polite" }, "Tap your 3 secret pictures.");
  const grid = h("div", { class: "pic-grid" }, LOCK_PICS.map((pic, i) => h("button", { type: "button", class: "pic", "aria-label": `Picture ${i + 1}: ${pic}`, onclick: () => tap(pic) }, pic)));
  const paint = () => [...slots.children].forEach((s, i) => { s.textContent = seq[i] ? "●" : ""; s.className = seq[i] ? "filled" : ""; });
  const tap = async (pic) => {
    if (Date.now() < pausedUntil) { msg.textContent = "Let's take a little break, then try again."; return; }
    if (seq.length >= 3) return;
    seq.push(pic); paint();
    if (seq.length < 3) return;
    const { hash } = await hashPicLock(seq, p.lock.salt);
    if (hash === p.lock.hash) { misses = 0; session.profileId = p.id; nav.shelf(p.id); return; }
    misses++;
    seq = [];
    grid.classList.remove("shake"); void grid.offsetWidth; grid.classList.add("shake");
    if (misses >= 3) { pausedUntil = Date.now() + 15000; misses = 0; msg.textContent = "Not quite. Let's wait a moment, or ask a grown-up."; }
    else msg.textContent = "Not quite. Try again!";
    setTimeout(paint, 300);
  };
  show(
    topbar({ title: `${p.avatar} ${p.name}`, back: () => picker() }),
    screen("narrow",
      h("h1", { class: "center-text" }, `Hi ${p.name}!`),
      msg, slots, grid,
      h("div", { class: "row center picker-foot" },
        button("Ask a grown-up", async () => {
          if (await askPasscode("Open " + p.name + "'s books", verifyGate)) { session.profileId = p.id; nav.shelf(p.id); }
        }, "ghost small"))));
}

// Parent picks the 3 pictures. Resolves with { salt, hash } or null.
function picLockSetter(container, onChange) {
  let seq = [];
  const shown = h("div", { class: "slots", "aria-live": "polite" }, [0, 1, 2].map(() => h("span")));
  const paint = () => [...shown.children].forEach((s, i) => { s.textContent = seq[i] || ""; s.className = seq[i] ? "filled" : ""; });
  const grid = h("div", { class: "pic-grid small" }, LOCK_PICS.map((pic) => h("button", { type: "button", class: "pic", "aria-label": "Add " + pic, onclick: () => { if (seq.length < 3) { seq.push(pic); paint(); onChange([...seq]); } } }, pic)));
  container.replaceChildren(
    h("p", { class: "small" }, "Tap 3 pictures in order (repeats are fine). Show your child the order."),
    shown, grid,
    h("div", { class: "row" }, button("Start over", () => { seq = []; paint(); onChange([]); }, "small ghost")));
}

// Create or edit a child profile (grown-up only).
export function profileEditor(existing, { onDone, title } = {}) {
  const p = existing ? store.get(existing.id) : null;
  const form = profileFields(p || {});
  const err = h("p", { class: "error", role: "alert" });
  let lockMode = p?.lock ? "keep" : "off"; // keep | off | new
  let newSeq = [];
  const setterBox = h("div");
  const lockOn = h("input", { type: "checkbox", checked: !!p?.lock });
  const lockStatus = h("p", { class: "small muted" });
  const refreshLock = () => {
    if (!lockOn.checked) { lockMode = "off"; setterBox.replaceChildren(); lockStatus.textContent = ""; return; }
    if (lockMode === "keep") {
      lockStatus.textContent = "Picture lock is on.";
      setterBox.replaceChildren(button("Choose new pictures", () => { lockMode = "new"; refreshLock(); }, "small ghost"));
      return;
    }
    lockMode = "new";
    lockStatus.textContent = "";
    picLockSetter(setterBox, (s) => { newSeq = s; });
  };
  lockOn.addEventListener("change", () => { if (lockOn.checked && lockMode === "off") lockMode = p?.lock ? "keep" : "new"; refreshLock(); });

  const save = h("button", { type: "submit", class: "btn go big" }, existing ? "Save changes" : "Add child");
  const submit = async (e) => {
    e.preventDefault();
    const v = form.read();
    if (v.error) { err.textContent = v.error; form.focus.focus(); return; }
    if (lockMode === "new" && newSeq.length !== 3) { err.textContent = "Tap 3 pictures for the picture lock, or untick it."; return; }
    await busy(save, "Saving…", async () => {
      let lock = null;
      if (lockMode === "keep") lock = p.lock;
      else if (lockMode === "new") lock = await hashPicLock(newSeq);
      await store.save({ ...(p || { kind: "profile" }), ...v, lock });
      toast(existing ? "Saved." : `Welcome, ${v.name}!`);
      onDone?.();
    });
  };
  const del = existing ? button("Delete profile…", async () => {
    const books = store.list("book", (b) => b.profileId === p.id);
    const ok = await typedConfirm({
      title: `Delete ${p.name}?`,
      body: `This deletes ${p.name}'s profile and ${books.length} ${books.length === 1 ? "book" : "books"}, with their drawings and photos. It can't be undone.`,
      word: "DELETE", yes: "Delete",
    });
    if (!ok) return;
    for (const b of books) await deleteBookData(b);
    await store.remove(p.id);
    toast(`${p.name}'s profile was deleted.`);
    onDone?.();
  }, "danger") : null;

  show(
    topbar({ title: title || (existing ? "Edit " + p.name : "Add a child"), back: () => onDone?.() }),
    screen("narrow",
      h("form", { class: "card stack", onsubmit: submit, novalidate: true },
        form.node,
        h("div", { class: "card soft sky stack" },
          h("h3", null, "🔐 Picture lock (optional)"),
          h("p", { class: "small" }, "A picture lock keeps brothers and sisters out of each other's books: the child taps 3 secret pictures to open their shelf. It's a friendly fence, not strong security. The parent passcode is the real lock that encrypts everything."),
          h("label", { class: "check" }, lockOn, h("span", null, "Use a picture lock")),
          lockStatus, setterBox),
        err, save),
      del ? h("div", { class: "row end picker-foot" }, del) : null));
  refreshLock();
  if (!existing) setTimeout(() => form.focus.focus(), 50);
}

// Remove a book and every image it references.
export async function deleteBookData(book) {
  const ids = new Set([book.cover, ...book.pages.map((x) => x.imageId), ...book.cast.map((c) => c.imageId)].filter(Boolean));
  for (const id of ids) await store.deleteImage(id);
  await store.remove(book.id);
}
