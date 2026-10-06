// Wish Circle app shell: boot, routing between screens, auto-lock, service worker.
import * as store from "./store.js";
import { h, show, closeModals, toast } from "./ui.js";
import { stopSpeech } from "./audio.js";
import { nav, session, screen, autolockMinutes } from "./screens/common.js";
import { welcome } from "./screens/setup.js";
import { unlockScreen } from "./screens/unlock.js";
import { picker } from "./screens/profiles.js";
import { shelf, openBook } from "./screens/shelf.js";
import { editor } from "./screens/editor.js";
import { parent } from "./screens/parent.js";

const HIDDEN_LOCK_MS = 3 * 60 * 1000;

// Every navigation goes through a guard: nothing but setup/unlock renders while locked.
const guarded = (fn) => (...args) => {
  if (!store.isUnlocked()) return showLocked();
  closeModals();
  return fn(...args);
};
Object.assign(nav, {
  start,
  picker: guarded(picker),
  shelf: guarded(shelf),
  openBook: guarded(openBook),
  editor: guarded(editor),
  parent: guarded(parent),
  lockNow,
});

// ---------- locking ----------
function showLocked(note) {
  stopSpeech();
  closeModals();
  const t = document.getElementById("toast");
  if (t) t.hidden = true; // a toast may name a child
  session.profileId = null;
  unlockScreen(note);
}
store.onLock(() => { if (!session.wiping) showLocked(); });

function lockNow(note) {
  if (store.isUnlocked()) store.lock(); // fires onLock → unlock screen
  else showLocked(note);
}

let lastActive = Date.now();
let hiddenAt = 0;
const markActive = () => { lastActive = Date.now(); };
for (const ev of ["pointerdown", "keydown", "touchstart", "wheel", "input"]) document.addEventListener(ev, markActive, { capture: true, passive: true });

function checkIdle() {
  if (!store.isUnlocked()) { lastActive = Date.now(); return; }
  if (Date.now() - lastActive > autolockMinutes() * 60 * 1000) {
    store.lock();
    toast("Locked to keep your books safe.");
  }
}
setInterval(checkIdle, 15 * 1000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    document.body.classList.add("veiled");
    stopSpeech();
    return;
  }
  document.body.classList.remove("veiled");
  if (store.isUnlocked() && hiddenAt && Date.now() - hiddenAt > HIDDEN_LOCK_MS) store.lock();
  else checkIdle();
  hiddenAt = 0;
});
// Restored from the back/forward cache (Safari): check right away.
window.addEventListener("pageshow", (e) => { if (e.persisted) checkIdle(); });

// ---------- boot ----------
async function start() {
  closeModals();
  let vault;
  try { vault = await store.hasVault(); }
  catch {
    show(screen("narrow center",
      h("div", { class: "card stack" },
        h("h1", null, "Can't open storage"),
        h("p", null, "This browser isn't letting Wish Circle save anything (private browsing can do this). Try a normal window, or add Wish Circle to your Home Screen."))));
    return;
  }
  if (!vault) welcome();
  else if (store.isUnlocked()) nav.picker();
  else showLocked();
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol !== "https:" && !local) return;
  navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => { /* offline support is optional */ });
}

document.getElementById("app")?.classList.remove("booting");
registerSW();
start();
