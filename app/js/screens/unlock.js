// Unlock screen: parent passcode, lockout countdown, and the honest "forgot passcode" path.
import { h, show, dialog } from "../ui.js";
import * as store from "../store.js";
import { nav, screen, field, formatWait, eraseEverything } from "./common.js";

let ticker = null;

export function unlockScreen(note) {
  clearInterval(ticker);
  const input = h("input", { class: "input", type: "password", autocomplete: "current-password", autofocus: true, id: "unlock-pass" });
  const go = h("button", { type: "submit", class: "btn big go wide" }, "Unlock");
  const msg = h("p", { class: "error", role: "alert" });
  const countdown = h("p", { class: "countdown", "aria-live": "polite", hidden: true });

  // Count down to a fixed end time, so throttled timers (app in background) can't stretch it.
  const startCountdown = (sec) => {
    clearInterval(ticker);
    const until = Date.now() + sec * 1000;
    const tick = () => {
      if (!countdown.isConnected) { clearInterval(ticker); return; }
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(ticker);
        countdown.hidden = true; input.disabled = false; go.disabled = false;
        msg.textContent = "You can try again now.";
        input.focus();
        return;
      }
      countdown.hidden = false;
      countdown.textContent = `⏳ Too many wrong tries. Try again in ${formatWait(left)}.`;
      input.disabled = true; go.disabled = true;
    };
    tick();
    ticker = setInterval(tick, 500);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    if (!input.value) { msg.textContent = "Type the parent passcode."; input.focus(); return; }
    go.disabled = true;
    const label = go.textContent;
    go.textContent = "Unlocking…";
    msg.textContent = "";
    let res;
    try { res = await store.unlock(input.value); } catch { res = { ok: false, wait: 0 }; }
    go.textContent = label;
    go.disabled = false;
    if (res.ok) { nav.picker(); return; }
    input.value = "";
    if (res.wait > 0) { msg.textContent = res.fails ? "That's not the passcode." : ""; startCountdown(res.wait); return; }
    const left = store.FREE_TRIES - (res.fails || 0);
    msg.textContent = left > 0 && left < store.FREE_TRIES
      ? `That's not the passcode. ${left} more ${left === 1 ? "try" : "tries"} before a short wait.`
      : "That's not the passcode.";
    input.focus();
  };

  show(screen("narrow center",
    h("form", { class: "card stack", onsubmit: submit, novalidate: true },
      h("span", { class: "lock-emoji", "aria-hidden": "true" }, "🔒"),
      h("h1", { class: "center-text" }, "Wish Circle is locked"),
      note ? h("p", { class: "center-text ok-text" }, note) : null,
      h("p", { class: "center-text" }, "A grown-up types the parent passcode to open the bookshelf."),
      field("Parent passcode", input),
      msg, countdown, go,
      h("p", { class: "center-text" }, h("button", { type: "button", class: "linkish", onclick: forgot }, "Forgot passcode?")),
    )));

  store.lockoutRemaining().then((w) => { if (w > 0) startCountdown(w); }).catch(() => {});
}

async function forgot() {
  const body = h("div", null,
    h("p", null, "Your children's books are locked with your passcode using strong encryption. Nobody, not even the people who made this app, can open them without it."),
    h("p", null, "So a forgotten passcode can't be reset or recovered. If you have a backup file, you'll still need the passcode you used when you made it."),
    h("p", null, "If you can't remember it, the only way forward is to erase everything on this device and start again."));
  const v = await dialog({ title: "Forgot the passcode?", body, choices: [
    { label: "Keep trying", value: false, cls: "ghost" },
    { label: "Erase everything…", value: true, cls: "danger" },
  ] });
  if (v) await eraseEverything();
}
