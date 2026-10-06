// End-to-end smoke test in real Chromium. Not part of `npm test` (needs a browser):
//   cd app && npm run test:e2e        (Playwright is loaded from the global node path)
// Flow: first-run setup → child profile → example book → comic → game first level → lock/unlock,
// then: zero console errors / CSP violations, raw IndexedDB holds no plaintext, the manifest is
// valid, the service worker registers and the app opens offline after the first visit.
//
// Env: HEADED=1 to watch it, E2E_OUT=<dir> for screenshots (default: OS temp dir).
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import net from "node:net";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.E2E_OUT || join(tmpdir(), "wish-circle-e2e");
mkdirSync(OUT, { recursive: true });

if (!existsSync(join(APP, "js/main.js")) || !existsSync(join(APP, "index.html"))) {
  console.log("SKIP e2e: app/js/main.js or app/index.html doesn't exist yet. Run again once the screens are in.");
  process.exit(0);
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const paths = (process.env.NODE_PATH || "").split(":").filter(Boolean);
  try { paths.push(execSync("npm root -g", { encoding: "utf8" }).trim()); } catch { /* no npm */ }
  try { return require(require.resolve("playwright", { paths: [APP, ...paths] })); } catch {
    console.log("SKIP e2e: Playwright isn't installed. Install it globally (npm i -g playwright && npx playwright install chromium).");
    process.exit(0);
  }
}
const { chromium } = loadPlaywright();

const CHILD = "Zephyrine";
const PASS = "purple otter sings";
// Words that must never appear unencrypted in IndexedDB (child name + example story words).
const SECRETS = [CHILD, "Pip the bunny", "adventure", "Treasure", "dragon", "tree house"];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on("error", reject);
});

async function waitForServer(url, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("http.server did not start");
}

const results = [];
let failed = 0;
function pass(name) { results.push(`  ok    ${name}`); }
function fail(name, err) { failed++; results.push(`  FAIL  ${name}\n        ${String(err?.message || err).split("\n").join("\n        ")}`); }
function warn(name, msg) { results.push(`  warn  ${name}: ${msg}`); }

const port = await freePort();
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", APP], { stdio: "ignore" });
const BASE = `http://localhost:${port}/`;
let browser;
try {
  await waitForServer(`http://127.0.0.1:${port}/index.html`);
  // localhost (not 127.0.0.1) is a secure context, so main.js registers the service worker.
  browser = await chromium.launch({ headless: !process.env.HEADED, args: [`--host-resolver-rules=MAP localhost 127.0.0.1`] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "allow" });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("request", (r) => { const u = r.url(); if (!u.startsWith(BASE) && !/^(blob|data):/.test(u)) errors.push(`request to another host: ${u}`); });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });

  const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {});
  const visible = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible().catch(() => false));
  // Click the first visible button/link whose accessible name matches one of the patterns.
  async function clickAny(patterns, { timeout = 8000 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const re of patterns) {
        for (const role of ["button", "link", "tab", "menuitem"]) {
          const loc = page.getByRole(role, { name: re });
          const n = await loc.count();
          for (let i = 0; i < n; i++) {
            const el = loc.nth(i);
            if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) { await el.click({ force: true, timeout: 5000 }); return re; }  // force: pulsing buttons never count as "stable"
          }
        }
      }
      await page.waitForTimeout(150);
    }
    throw new Error(`no visible button matching ${patterns.map(String).join(" | ")}`);
  }
  async function step(name, fn) {
    try { await fn(); pass(name); return true; } catch (e) { fail(name, e); await shot("fail-" + name.replace(/\W+/g, "-")); return false; }
  }

  // 1. First run: welcome → passcode → first child.
  await page.goto(BASE);
  const setupOk = await step("first-run setup (parent passcode)", async () => {
    await clickAny([/let's begin|get started|begin|start/i]);
    const pw = page.locator('input[type="password"]');
    await pw.first().waitFor();
    await page.waitForTimeout(300); // let the screen settle (autofocus, re-renders)
    const n = await pw.count();
    for (let i = 0; i < n; i++) await pw.nth(i).fill(PASS);
    for (let i = 0; i < n; i++) if ((await pw.nth(i).inputValue()) !== PASS) throw new Error(`passcode field ${i + 1} didn't keep its value`);
    const box = page.locator('input[type="checkbox"]');
    if (await box.count()) await box.first().check();
    await clickAny([/create passcode|continue|next|save/i]);
    await page.getByLabel(/name/i).first().waitFor({ timeout: 20000 }).catch(async () => {
      throw new Error("profile form didn't appear: " + (await page.getByRole("alert").allInnerTexts()).join(" / "));
    });
  });
  const profileOk = setupOk && await step("first child profile", async () => {
    const name = page.getByLabel(/name/i).first();
    await name.waitFor({ timeout: 20000 }); // PBKDF2 600k runs first
    await name.fill(CHILD);
    await clickAny([/make profile|save|create|done|next/i]);
    await page.getByText(CHILD, { exact: false }).first().waitFor();
  });
  const shelfOk = profileOk && await step("open the child's bookshelf", async () => {
    await clickAny([new RegExp(CHILD, "i")]);
    // The example lives either on the shelf or inside the story editor.
    try { await clickAny([/example|sample/i], { timeout: 3000 }); } catch {
      await clickAny([/write a new book|new book|write/i]);
      await clickAny([/example|sample/i], { timeout: 10000 });
    }
  });
  const bookOk = shelfOk && await step("example book is created", async () => {
    // Editor: example text → "Make my book" → review → "Save my book" → the book opens.
    const saveBtn = page.getByRole("button", { name: /save my book/i });
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (await visible(saveBtn)) { await saveBtn.first().click(); break; }
      try { await clickAny([/make (my )?book|make it|create|looks good|next|continue/i], { timeout: 1500 }); } catch { /* keep looking */ }
    }
    await page.locator(".comic, .book-card, .book").first().waitFor({ timeout: 20000 });
  });
  const comicOk = bookOk && await step("comic reader shows a page", async () => {
    if (!(await visible(page.locator(".comic")))) {
      if (await visible(page.locator(".book-card"))) await page.locator(".book-card").first().click();
      if (!(await visible(page.locator(".comic")))) await clickAny([/read|comic/i]);
    }
    await page.locator(".comic").first().waitFor();
    await page.locator(".comic canvas, .comic img, .comic-page, .comic-stage *").first().waitFor();
    if (!/Pip/.test(await page.locator(".comic").first().innerText())) throw new Error("the example story's hero isn't shown in the comic");
    await shot("comic");
    try { await clickAny([/next page|next|turn/i], { timeout: 2000 }); } catch { warn("comic", "no page-turn button found"); }
  });
  const gameOk = bookOk && await step("game starts and reaches the first level", async () => {
    try { await clickAny([/play/i], { timeout: 3000 }); } catch {
      await clickAny([/back/i]); await clickAny([/play/i]);
    }
    await page.locator(".game, #game, canvas").first().waitFor();
    const level = page.getByText(/level\s*1\b/i).or(page.locator("[data-level], .game-level"));
    const end = Date.now() + 30000;
    while (Date.now() < end && !(await visible(level))) {
      try { await clickAny([/^\W*(next|play|start|go|let's go|continue)\b/i], { timeout: 1500 }); } catch { /* story step may advance itself */ }
      if (process.env.E2E_DEBUG) console.log("game:", await page.locator(".game h1").first().innerText().catch(() => "?"), "|", (await page.locator(".game button").allInnerTexts()).join(" / "));
    }
    await shot("game-level");
    if (!(await visible(level))) throw new Error("the game never showed \"Level 1\"");
    // Tap the level's action buttons a few times; there are no failure states.
    for (let i = 0; i < 6; i++) {
      const act = page.locator(".g-controls button, .game button.big").first();
      if (await visible(act)) await act.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    await clickAny([/back|exit|close|quit/i], { timeout: 3000 });
  });
  void comicOk; void gameOk;

  // 2. Lock and unlock.
  const lockOk = profileOk && await step("lock, wrong passcode rejected, right passcode unlocks", async () => {
    const lockBtn = page.getByRole("button", { name: /(^|\W)lock\b|^🔒$/i });
    for (let i = 0; i < 5 && !(await visible(lockBtn)); i++) {
      try { await clickAny([/back|exit|home|close|leave|discard/i], { timeout: 1500 }); } catch { break; }
    }
    await clickAny([/(^|\W)lock\b|^🔒$/i]);
    try { await clickAny([/^(yes|lock( now)?|ok)$/i], { timeout: 1200 }); } catch { /* no confirm step */ }
    const pw = page.locator('input[type="password"]').first();
    await pw.waitFor();
    if (await visible(page.getByText(CHILD))) throw new Error("child's name is visible while locked");
    await pw.fill("not the passcode");
    await clickAny([/unlock/i]);
    await page.getByRole("alert").filter({ hasText: /not/i }).first().waitFor();
    await pw.fill(PASS);
    await clickAny([/unlock/i]);
    await page.getByText(CHILD).first().waitFor({ timeout: 20000 });
  });

  // 3. What is actually stored on disk.
  await step("raw IndexedDB holds only ids and ciphertext", async () => {
    const dump = await page.evaluate(async () => {
      const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: "wishcircle" }];
      const out = { dbs: dbs.map((d) => d.name), stores: {}, text: "" };
      const toText = (v) => {
        if (v instanceof ArrayBuffer) v = new Uint8Array(v);
        if (ArrayBuffer.isView(v)) return new TextDecoder("latin1").decode(v) + new TextDecoder().decode(v);
        if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => k + ":" + toText(x)).join("|");
        return String(v);
      };
      for (const { name } of dbs) {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const s of db.objectStoreNames) {
          const rows = await new Promise((res, rej) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          out.stores[name + "/" + s] = { count: rows.length, keys: [...new Set(rows.flatMap((r) => Object.keys(r)))] };
          out.text += rows.map(toText).join("\n");
        }
        db.close();
      }
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
      out.localStorage = ls;
      out.sessionStorage = sessionStorage.length;
      return out;
    });
    const recs = dump.stores["wishcircle/records"];
    if (!recs || recs.count < 1) throw new Error("no encrypted records found: " + JSON.stringify(dump.stores));
    for (const [s, info] of Object.entries(dump.stores)) {
      const extra = info.keys.filter((k) => !["id", "iv", "ct", "v", "kdf", "iterations", "salt", "wrapped", "fails", "until"].includes(k));
      if (extra.length) throw new Error(`${s} has unexpected plaintext fields: ${extra.join(", ")}`);
    }
    const leaks = SECRETS.filter((w) => dump.text.toLowerCase().includes(w.toLowerCase()));
    if (leaks.length) throw new Error("plaintext found in IndexedDB: " + leaks.join(", "));
    for (const [k, v] of Object.entries(dump.localStorage)) {
      if (!k.startsWith("wc.")) throw new Error(`localStorage key ${k} doesn't start with wc.`);
      if (SECRETS.some((w) => String(v).toLowerCase().includes(w.toLowerCase()))) throw new Error(`localStorage ${k} holds user text`);
    }
    if (dump.sessionStorage) throw new Error("sessionStorage is used");
  });

  // 4. Manifest.
  await step("manifest is linked and valid", async () => {
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    const r = await page.request.get(new URL(href, BASE).href);
    if (!r.ok()) throw new Error("manifest HTTP " + r.status());
    const m = await r.json();
    for (const [k, v] of Object.entries({ name: "Wish Circle", start_url: "./", scope: "./", display: "standalone" })) if (m[k] !== v) throw new Error(`manifest ${k} = ${m[k]}`);
    for (const i of m.icons) { const ir = await page.request.get(new URL(i.src, new URL(href, BASE)).href); if (!ir.ok()) throw new Error("icon missing " + i.src); }
    if (!m.icons.some((i) => i.purpose === "maskable")) throw new Error("no maskable icon");
  });

  // 5. Service worker + offline.
  const swOk = await step("service worker registers and activates", async () => {
    const state = await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then((r) => r.active && r.active.state),
      new Promise((r) => setTimeout(() => r("timeout"), 10000)),
    ]));
    if (state !== "activated" && state !== "activating") throw new Error("service worker state: " + state);
    const cached = await page.evaluate(async () => { const n = await caches.keys(); let c = 0; for (const k of n) c += (await (await caches.open(k)).keys()).length; return { n, c }; });
    if (!cached.c) throw new Error("nothing precached: " + JSON.stringify(cached));
  });
  if (swOk) await step("app loads offline after the first visit", async () => {
    await page.reload(); // make sure this page is controlled
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    // setOffline alone doesn't cut the service worker's own fetches in Chromium, so also stop
    // the server: if the app still loads, it truly came from the cache.
    await context.setOffline(true);
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    await page.reload();
    await page.locator("#app").waitFor();
    await page.locator('input[type="password"], .screen, main').first().waitFor({ timeout: 10000 });
    await shot("offline");
    const boot = await page.locator("#app").innerText();
    if (/opening wish circle/i.test(boot) && !(await visible(page.locator('input[type="password"]')))) throw new Error("app stuck on boot screen offline");
  });
  void lockOk;

  // 6. Console.
  await step("no console errors, page errors or CSP violations", async () => {
    if (errors.length) throw new Error(errors.join("\n"));
  });
} catch (e) {
  fail("e2e harness", e);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}

console.log(`Wish Circle e2e (${BASE})\n${results.join("\n")}\nScreenshots: ${OUT}`);
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll e2e checks passed.");
process.exit(failed ? 1 : 0);
