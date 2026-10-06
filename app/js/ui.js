// Tiny DOM helpers. User text only ever goes in through textContent — never parsed as HTML.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") Object.assign(el.style, v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") value = v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const root = () => document.getElementById("app");
export function show(...nodes) {
  const r = root();
  r.replaceChildren();
  append(r, nodes);
  r.scrollTop = 0;
  window.scrollTo(0, 0);
  const focus = r.querySelector("[autofocus]");
  if (focus) setTimeout(() => focus.focus(), 50);
}

export function button(label, onClick, cls = "") {
  return h("button", { type: "button", class: "btn " + cls, onclick: onClick }, label);
}

export function topbar({ title, back, actions = [] }) {
  return h("header", { class: "topbar" },
    back ? h("button", { type: "button", class: "chip", onclick: back, "aria-label": "Back" }, "‹ Back") : h("span", { class: "brand" }, "Wish Circle"),
    h("h1", { class: "topbar-title" }, title || ""),
    h("div", { class: "topbar-actions" }, actions),
  );
}

let toastTimer;
export function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = h("div", { id: "toast", role: "status", "aria-live": "polite" }); document.body.appendChild(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// Modal layer shared by dialog/askPasscode: Escape closes, Tab stays inside, focus returns after.
export function modal(content, onCancel) {
  const before = document.activeElement;
  const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) onCancel?.(); } }, content);
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel?.(); return; }
    if (e.key !== "Tab") return;
    const f = [...wrap.querySelectorAll("button,input,select,textarea,[tabindex]")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.body.appendChild(wrap);
  return { wrap, close() { wrap.remove(); if (before && before.isConnected) before.focus?.(); } };
}
export function closeModals() { document.querySelectorAll(".modal-wrap").forEach((m) => m.remove()); }

// In-page dialog (no alert/confirm). Resolves with the value of the clicked choice (null on Escape).
export function dialog({ title, body, choices }) {
  return new Promise((resolve) => {
    let m;
    const close = (v) => { m.close(); resolve(v); };
    m = modal(
      h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", null, title),
        body ? (body instanceof Node ? body : h("p", null, body)) : null,
        h("div", { class: "row end" }, choices.map((c) => button(c.label, () => close(c.value), c.cls || ""))),
      ), () => close(null));
    m.wrap.querySelector(".btn:last-child")?.focus();
  });
}
export const confirmBox = (title, body, yes = "Yes", cls = "danger") =>
  dialog({ title, body, choices: [{ label: "Cancel", value: false, cls: "ghost" }, { label: yes, value: true, cls }] });

// Ask for the parent passcode. Resolves with the passcode or null.
// verify(pass) → true | false | "message to show" (e.g. a lockout wait).
export function askPasscode(title = "Grown-ups only", verify, prompt = "Enter the parent passcode.") {
  return new Promise((resolve) => {
    const input = h("input", { type: "password", autocomplete: "current-password", id: "gate-pass", "aria-label": "Parent passcode", class: "input" });
    const err = h("p", { class: "error", role: "alert" });
    const go = h("button", { type: "submit", class: "btn" }, "Continue");
    let m;
    const finish = (v) => { m.close(); resolve(v); };
    const submit = async (e) => {
      e?.preventDefault();
      if (go.disabled) return;
      if (!input.value) { err.textContent = "Type the passcode first."; input.focus(); return; }
      go.disabled = true;
      err.textContent = "Checking…";
      let ok;
      try { ok = await verify(input.value); } catch { ok = false; }
      go.disabled = false;
      if (ok === true) finish(input.value);
      else { err.textContent = typeof ok === "string" ? ok : "That's not the parent passcode."; input.value = ""; input.focus(); }
    };
    m = modal(
      h("form", { class: "modal", onsubmit: submit, role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", null, "🔒 " + title),
        h("p", null, prompt),
        input, err,
        h("div", { class: "row end" },
          button("Cancel", () => finish(null), "ghost"),
          go),
      ), () => finish(null));
    setTimeout(() => input.focus(), 30);
  });
}

// Offer a file to the user (backup, shared book). In an installed iPhone/iPad app a plain
// download has nowhere to go, so the share sheet ("Save to Files") is used there when possible.
export async function saveFile(name, text, type = "application/json") {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone && navigator.canShare) {
    try {
      const file = new File([text], name, { type });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return true; }
    } catch (e) { if (e?.name === "AbortError") return false; }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
// Resolves with the chosen files ([] if the picker is cancelled).
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple, hidden: true });
    const done = (files) => { resolve(files); input.remove(); };
    input.addEventListener("change", () => done([...input.files]));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
