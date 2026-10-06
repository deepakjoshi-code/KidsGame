// The service worker's precache list must match the app's real runtime files exactly,
// or the app breaks offline (missing file) or the install logs a failed fetch (stale entry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SW = readFileSync(join(APP, "sw.js"), "utf8");

const EXCLUDED_DIRS = new Set(["tests", "tools", "docs", "node_modules", "test-results", "playwright-report"]);
const EXCLUDED_FILES = new Set(["_headers", "_redirects", "package.json", "package-lock.json", "sw.js", "netlify.toml", "wrangler.toml"]);
const EXCLUDED_EXT = /\.(md|py|map|log|txt)$/i;
const EXCLUDED_NAME = /^(LICEN[CS]E|NOTICE|COPYING)(\..*)?$/i; // licence texts shipped with vendor/ code

function runtimeFiles(dir = APP, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const r = relative(APP, p).split("\\").join("/");
    if (statSync(p).isDirectory()) { if (!EXCLUDED_DIRS.has(name)) runtimeFiles(p, out); continue; }
    if (EXCLUDED_FILES.has(r) || EXCLUDED_EXT.test(name) || EXCLUDED_NAME.test(name)) continue;
    out.push(r);
  }
  return out;
}

function shellList() {
  const m = SW.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, "sw.js declares const SHELL = [...]");
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1].replace(/^\.\//, ""));
}

test("sw.js has a VERSION and the expected lifecycle", () => {
  assert.match(SW, /const\s+VERSION\s*=\s*["'`][^"'`]+["'`]/);
  for (const s of ["skipWaiting", "clients.claim", "caches.delete", '"install"', '"activate"', '"fetch"']) assert.ok(SW.includes(s), s);
  assert.ok(/url\.origin\s*!==\s*self\.location\.origin/.test(SW), "cross-origin requests are ignored");
});

test("SHELL has no duplicates or absolute/external entries", () => {
  const list = shellList();
  assert.equal(new Set(list).size, list.length, "duplicates in SHELL");
  for (const p of list) assert.ok(!/^(\/|https?:|\/\/)/.test(p), `relative path expected: ${p}`);
});

test("every SHELL entry exists on disk", () => {
  const missing = shellList().filter((p) => !existsSync(join(APP, p)));
  assert.deepEqual(missing, [], `listed in sw.js SHELL but missing on disk:\n  ${missing.join("\n  ")}`);
});

test("every runtime file under app/ is in SHELL", () => {
  const listed = new Set(shellList());
  const unlisted = runtimeFiles().filter((f) => !listed.has(f)).sort();
  assert.deepEqual(unlisted, [], `runtime files missing from sw.js SHELL (add them and bump VERSION):\n  ${unlisted.join("\n  ")}`);
});

test("manifest icons and index.html links are precached", (t) => {
  const listed = new Set(shellList());
  const manifest = JSON.parse(readFileSync(join(APP, "manifest.webmanifest"), "utf8"));
  for (const i of manifest.icons) assert.ok(listed.has(i.src), i.src);
  if (!existsSync(join(APP, "index.html"))) return t.skip("index.html not created yet");
  const html = readFileSync(join(APP, "index.html"), "utf8");
  const refs = [...html.matchAll(/\b(?:href|src)=["']([^"'#?]+)["']/g)].map((m) => m[1].replace(/^\.\//, "")).filter((r) => !/^[a-z]+:/i.test(r));
  for (const r of refs) assert.ok(listed.has(r), `index.html references ${r}, not in SHELL`);
});

test("every module imported (statically or dynamically) from js/ is precached", () => {
  const listed = new Set(shellList());
  const problems = [];
  for (const f of runtimeFiles().filter((x) => x.endsWith(".js"))) {
    const src = readFileSync(join(APP, f), "utf8");
    for (const m of src.matchAll(/(?:\bimport\s*(?:[\w*{}\s,$]+from\s*)?|\bimport\s*\(\s*)["'`](\.[^"'`]+)["'`]/g)) {
      const target = posix.normalize(posix.join(posix.dirname(f), m[1]));
      if (!listed.has(target)) problems.push(`${f} imports ${m[1]} → ${target} (not in SHELL)`);
      if (!existsSync(join(APP, target))) problems.push(`${f} imports ${m[1]} → ${target} (file missing)`);
    }
  }
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});

test("manifest is a valid installable web app manifest", () => {
  const m = JSON.parse(readFileSync(join(APP, "manifest.webmanifest"), "utf8"));
  assert.equal(m.name, "Wish Circle");
  assert.equal(m.short_name, "Wish Circle");
  assert.equal(m.start_url, "./");
  assert.equal(m.scope, "./");
  assert.equal(m.display, "standalone");
  assert.equal(m.background_color, "#fbf4e2");
  assert.equal(m.theme_color, "#fbf4e2");
  assert.deepEqual(m.categories, ["kids", "education", "books"]);
  const has = (size, purpose) => m.icons.some((i) => i.sizes === size && i.type === "image/png" && (i.purpose || "any").split(" ").includes(purpose));
  assert.ok(has("192x192", "any"));
  assert.ok(has("512x512", "any"));
  assert.ok(has("512x512", "maskable"));
  for (const i of m.icons) {
    const buf = readFileSync(join(APP, i.src));
    assert.equal(buf.subarray(1, 4).toString(), "PNG", `${i.src} is a PNG`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    assert.equal(`${w}x${h}`, i.sizes, `${i.src} real size`);
  }
});
