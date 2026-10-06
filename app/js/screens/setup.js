// First run: welcome → parent passcode → first child profile. Also "restore a backup" on a new device.
import { h, show, button, toast, pickFile, modal } from "../ui.js";
import * as store from "../store.js";
import { passcodeProblem } from "../crypto.js";
import { nav, screen, field, busy, profileFields } from "./common.js";

const PROMISE = "Everything stays on this device, locked with your passcode. No accounts, no ads, nothing sent anywhere.";

function steps(n) {
  return h("div", { class: "steps", "aria-label": `Step ${n} of 3` }, [1, 2, 3].map((i) => h("span", { class: i <= n ? "on" : "" })));
}

export function welcome() {
  show(screen("narrow center stack",
    h("div", { class: "logo" }, h("span", { class: "star", "aria-hidden": "true" }, "🌟"), " Wish Circle"),
    h("p", { class: "tagline" }, "Your stories, your comics, your game."),
    h("ul", { class: "features" },
      h("li", null, h("span", { class: "ico", "aria-hidden": "true" }, "✏️"), h("span", null, "Write your story, or take photos of the book you made.")),
      h("li", null, h("span", { class: "ico", "aria-hidden": "true" }, "📖"), h("span", null, "See it turned into comic pages to read aloud and print.")),
      h("li", null, h("span", { class: "ico", "aria-hidden": "true" }, "🎮"), h("span", null, "Play it as a game made from your own story!"))),
    h("p", { class: "promise" }, h("span", { class: "lock", "aria-hidden": "true" }, "🔒"), PROMISE),
    button("Let's begin ›", createPasscode, "big go wide"),
    h("p", { class: "center-text muted small" }, "A grown-up sets things up first. It takes a minute."),
    h("p", { class: "center-text" }, h("button", { type: "button", class: "linkish", onclick: restoreFromWelcome }, "I have a Wish Circle backup file")),
  ));
}

function createPasscode() {
  const p1 = h("input", { class: "input", type: "password", autocomplete: "new-password", autofocus: true });
  const p2 = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const strength = h("p", { class: "strength", "aria-live": "polite" });
  const err = h("p", { class: "error", role: "alert" });
  const agree = h("input", { type: "checkbox" });
  const go = h("button", { type: "submit", class: "btn big go wide" }, "Create passcode");
  const check = () => {
    if (!p1.value) { strength.textContent = ""; strength.className = "strength"; return; }
    const prob = passcodeProblem(p1.value);
    strength.textContent = prob || "👍 Good passcode.";
    strength.className = "strength " + (prob ? "bad" : "good");
  };
  p1.addEventListener("input", check);
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    const prob = passcodeProblem(p1.value);
    if (prob) { err.textContent = prob; p1.focus(); return; }
    if (p1.value !== p2.value) { err.textContent = "The two passcodes don't match."; p2.focus(); return; }
    if (!agree.checked) { err.textContent = "Please tick the box to confirm you're the parent or guardian."; return; }
    await busy(go, "Locking it up…", async () => {
      try { await store.setup(p1.value); } catch (x) { err.textContent = x.message || "Something went wrong."; return; }
      firstChild();
    });
  };
  show(screen("narrow center",
    h("form", { class: "card stack", onsubmit: submit, novalidate: true },
      steps(1),
      h("h1", null, "🔒 Make a parent passcode"),
      h("p", null, "This passcode locks everything your children make. Only you should know it."),
      h("p", { class: "muted small" }, "Use at least 6 characters. A short sentence is easy to remember and hard to guess. There's no way to recover a forgotten passcode, so write it down somewhere safe."),
      field("Passcode", p1), strength,
      field("Type it again", p2),
      h("label", { class: "check" }, agree, h("span", null, "I'm the parent or guardian.")),
      err, go,
    )));
}

function firstChild() {
  const form = profileFields();
  const err = h("p", { class: "error", role: "alert" });
  const go = h("button", { type: "submit", class: "btn big go wide" }, "Make profile");
  const submit = async (e) => {
    e.preventDefault();
    const v = form.read();
    if (v.error) { err.textContent = v.error; form.focus.focus(); return; }
    await busy(go, "Saving…", async () => {
      await store.save({ kind: "profile", ...v, lock: null });
      toast(`Hello, ${v.name}!`);
      nav.picker();
    });
  };
  show(screen("narrow center",
    h("form", { class: "card stack", onsubmit: submit, novalidate: true },
      steps(2),
      h("h1", null, "👋 Who's the first reader?"),
      h("p", null, "Each child gets their own bookshelf. You can add more children later in Grown-ups."),
      form.node, err, go)));
  setTimeout(() => form.focus.focus(), 50);
}

// Restore an encrypted backup onto a fresh device, before any vault exists.
export async function restoreFlow(onDone) {
  const [file] = await pickFile(".json,application/json");
  if (!file) return;
  if (file.size > 400 * 1024 * 1024) { toast("That file is too big to be a backup."); return; }
  const text = await file.text();
  const input = h("input", { class: "input", type: "password", autocomplete: "current-password", "aria-label": "Backup passcode" });
  const err = h("p", { class: "error", role: "alert" });
  const go = h("button", { type: "submit", class: "btn go" }, "Restore");
  let m;
  const submit = async (e) => {
    e.preventDefault();
    if (!input.value) { err.textContent = "Type the passcode of this backup."; return; }
    await busy(go, "Opening…", async () => {
      const problem = await store.importBackup(text, input.value);
      if (problem) { err.textContent = problem; input.value = ""; input.focus(); return; }
      m.close();
      toast("Backup restored! Unlock with the backup's passcode.");
      onDone?.();
    });
  };
  m = modal(h("form", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Restore backup", onsubmit: submit },
    h("h2", null, "📦 Restore a backup"),
    h("p", null, "Enter the parent passcode that was used when this backup was made. Everything on this device will be replaced by the backup."),
    input, err,
    h("div", { class: "row end" }, button("Cancel", () => m.close(), "ghost"), go)), () => m.close());
  setTimeout(() => input.focus(), 30);
}

function restoreFromWelcome() { restoreFlow(() => nav.start()); }
