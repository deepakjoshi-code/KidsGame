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

// In-page dialog (no alert/confirm). Resolves with the value of the clicked choice.
export function dialog({ title, body, choices }) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.remove(); resolve(v); };
    const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) close(null); } },
      h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", null, title),
        body ? (body instanceof Node ? body : h("p", null, body)) : null,
        h("div", { class: "row end" }, choices.map((c) => button(c.label, () => close(c.value), c.cls || ""))),
      ));
    document.body.appendChild(wrap);
    wrap.querySelector(".btn:last-child")?.focus();
  });
}
export const confirmBox = (title, body, yes = "Yes", cls = "danger") =>
  dialog({ title, body, choices: [{ label: "Cancel", value: false, cls: "ghost" }, { label: yes, value: true, cls }] });

// Ask for the parent passcode. Resolves with the passcode or null.
export function askPasscode(title = "Grown-ups only", verify) {
  return new Promise((resolve) => {
    const input = h("input", { type: "password", autocomplete: "current-password", id: "gate-pass", "aria-label": "Parent passcode", class: "input" });
    const err = h("p", { class: "error", role: "alert" });
    const submit = async (e) => {
      e?.preventDefault();
      err.textContent = "Checking…";
      const ok = await verify(input.value);
      if (ok) { wrap.remove(); resolve(input.value); }
      else { err.textContent = "That's not the parent passcode."; input.value = ""; input.focus(); }
    };
    const wrap = h("div", { class: "modal-wrap" },
      h("form", { class: "modal", onsubmit: submit, role: "dialog", "aria-modal": "true" },
        h("h2", null, "🔒 " + title),
        h("p", null, "Enter the parent passcode."),
        input, err,
        h("div", { class: "row end" },
          button("Cancel", () => { wrap.remove(); resolve(null); }, "ghost"),
          h("button", { type: "submit", class: "btn" }, "Continue")),
      ));
    document.body.appendChild(wrap);
    setTimeout(() => input.focus(), 30);
  });
}

// Offer a file to the user (backup, shared book).
export function saveFile(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple, style: { display: "none" } });
    input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}
