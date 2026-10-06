// Static security lint for the app's own code. Zero dependencies: regexes over the source.
// It enforces the CONTRACT.md rules: no HTML injection sinks, no inline script/style, no
// external hosts, and storage only through the encrypted store (plus "wc." UI prefs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f) => relative(APP, f).split("\\").join("/");

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

const jsFiles = [...walk(join(APP, "js"), (p) => p.endsWith(".js")), join(APP, "sw.js")].filter(existsSync);
const cssFiles = walk(join(APP, "css"), (p) => p.endsWith(".css"));
const htmlFiles = [join(APP, "index.html")].filter(existsSync);

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https://api.rawrbooks.com; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Blank out comments but keep line numbers and string contents intact.
function stripJsComments(src) {
  let out = "", i = 0, mode = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") mode = c;
      out += c; i++;
    } else if (mode === "line") {
      if (c === "\n") { mode = null; out += c; } i++;
    } else if (mode === "block") {
      if (c === "*" && n === "/") { mode = null; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++;
    } else {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === mode || (c === "\n" && mode !== "`")) mode = null;
      i++;
    }
  }
  return out;
}
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));

function findAll(src, re) {
  const hits = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  while ((m = g.exec(src))) {
    hits.push({ line: src.slice(0, m.index).split("\n").length, index: m.index, match: m[0], m });
    if (m[0] === "") g.lastIndex++;
  }
  return hits;
}

const JS_RULES = [
  [/\binnerHTML\b/, "innerHTML"],
  [/\bouterHTML\b/, "outerHTML"],
  [/\binsertAdjacentHTML\b/, "insertAdjacentHTML"],
  [/\bdocument\s*\.\s*write(ln)?\s*\(/, "document.write"],
  [/(^|[^.\w$])eval\s*\(/, "eval("],
  [/\bnew\s+Function\b/, "new Function"],
  [/(^|[^.\w$])Function\s*\(\s*["'`]/, "Function(string)"],
  [/\bset(Timeout|Interval)\s*\(\s*["'`]/, "setTimeout/setInterval with a string"],
  [/\bsetAttribute(NS)?\s*\(\s*(null\s*,\s*)?["'`]style["'`]/, 'setAttribute("style")'],
  [/\bsetAttribute(NS)?\s*\(\s*(null\s*,\s*)?["'`]on\w+["'`]/, 'setAttribute("on…") inline handler'],
  [/\bcreateContextualFragment\b/, "createContextualFragment"],
  [/\bparseFromString\s*\([^)]*text\/html/, "DOMParser text/html"],
  [/\bsrcdoc\b/, "srcdoc"],
  [/javascript:/i, "javascript: URL"],
  [/\bsessionStorage\b/, "sessionStorage (contract: use the encrypted store)"],
  [/\bdocument\s*\.\s*cookie\b/, "document.cookie"],
  [/\bsendBeacon\b/, "navigator.sendBeacon"],
  [/\bnew\s+(WebSocket|EventSource)\b/, "WebSocket/EventSource"],
  [/\bimportScripts\s*\(/, "importScripts"],
];

// XML namespace identifiers are not network requests.
const NAMESPACES = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml", "http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace"]);
// The family's comic reader (Claude AI, off by default) is the one host the CSP's connect-src allows.
const CONNECT_HOSTS = new Set(["https://api.rawrbooks.com"]);
function externalUrls(raw) {
  return findAll(raw, /\b(https?|wss?|ftp):\/\/[^\s"'`)<>]*/i)
    .filter((h) => !NAMESPACES.has(h.match.replace(/[.,;]+$/, "")) && !CONNECT_HOSTS.has(h.match.replace(/[.,;/]+$/, "")));
}
// Protocol-relative URLs in markup/CSS: src="//cdn…", url(//cdn…)
function protocolRelative(raw) {
  return findAll(raw, /(src|href|action)\s*=\s*["']\/\/|url\(\s*["']?\/\//i);
}

function lintJs(file) {
  const raw = readFileSync(file, "utf8");
  const code = stripJsComments(raw);
  const v = [];
  for (const [re, name] of JS_RULES) for (const h of findAll(code, re)) v.push(`${rel(file)}:${h.line} ${name}`);
  for (const h of externalUrls(raw)) v.push(`${rel(file)}:${h.line} external URL ${h.match}`);
  v.push(...lintLocalStorage(file, code));
  if (!rel(file).endsWith("js/store.js")) {
    for (const h of findAll(code, /\bindexedDB\b/)) v.push(`${rel(file)}:${h.line} indexedDB outside js/store.js (contract: everything goes through the store)`);
  }
  if (rel(file) !== "sw.js") {
    for (const h of findAll(code, /\bcaches\s*\.\s*(open|match)\b/)) v.push(`${rel(file)}:${h.line} Cache API outside sw.js`);
  }
  return v;
}

// localStorage keys must be string literals (or consts) starting with "wc.".
function lintLocalStorage(file, code) {
  const v = [];
  const consts = new Map();
  for (const h of findAll(code, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`]*)\2/)) consts.set(h.m[1], h.m[3]);
  // const KEYS = { sound: "wc.sound", ... }: KEYS[x] is fine when every value is a "wc." string.
  const keyMaps = new Set();
  for (const h of findAll(code, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*)\}/)) {
    const vals = [...h.m[2].matchAll(/:\s*(["'`])([^"'`]*)\1/g)].map((x) => x[2]);
    if (vals.length && vals.every((x) => x.startsWith("wc.")) && !/:\s*[^"'`\s]/.test(h.m[2])) keyMaps.add(h.m[1]);
  }
  for (const h of findAll(code, /\blocalStorage\b\s*(\??\.\s*([A-Za-z_$][\w$]*)|\[)?/)) {
    const where = `${rel(file)}:${h.line}`;
    const method = h.m[2];
    if (method === "clear" || method === "length") continue;
    if (method === "getItem" || method === "setItem" || method === "removeItem") {
      const after = code.slice(h.index).match(new RegExp(`\\b${method}\\s*\\(\\s*([^,)]+)`));
      const arg = after ? after[1].trim() : "";
      let key = null;
      const lit = arg.match(/^(["'`])(.*?)\1$/) || arg.match(/^`([^`$]*)\$\{/) && [null, null, arg.slice(1, arg.indexOf("${"))];
      const indexed = arg.match(/^([A-Za-z_$][\w$]*)\s*\[/);
      if (lit) key = lit[2];
      else if (/^(["'`])wc\.\1\s*\+/.test(arg)) key = "wc.";
      else if (consts.has(arg)) key = consts.get(arg);
      else if (indexed && keyMaps.has(indexed[1])) key = "wc.";
      else if (method === "removeItem") continue; // removing a key can't store anything
      if (key === null) v.push(`${where} localStorage.${method} with a non-literal key (${arg}); use a "wc."-prefixed literal or const`);
      else if (!key.startsWith("wc.")) v.push(`${where} localStorage key "${key}" does not start with "wc."`);
      continue;
    }
    if (h.m[1] === undefined) {
      // Bare reference, e.g. `const ls = localStorage` or `"localStorage" in window`.
      const line = code.split("\n")[h.line - 1];
      if (/["'`]localStorage["'`]\s+in\b|typeof\s+localStorage|Object\.keys\(\s*localStorage\s*\)/.test(line)) continue;
      if (/\blocalStorage\s*\)/.test(line) || /=\s*localStorage\b/.test(line)) { v.push(`${where} localStorage aliased; call getItem/setItem directly with "wc." keys`); continue; }
      continue;
    }
    v.push(`${where} localStorage${h.m[1].trim()} (direct property access); use getItem/setItem with "wc." keys`);
  }
  return v;
}

function lintHtml(file) {
  const raw = readFileSync(file, "utf8");
  const html = stripHtmlComments(raw);
  const v = [];
  const at = (h, msg) => v.push(`${rel(file)}:${h.line} ${msg}`);
  for (const h of findAll(html, /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/i)) {
    if (!/\bsrc\s*=/.test(h.m[1])) at(h, "inline <script> without src");
    else if (h.m[2].trim()) at(h, "<script src> with inline body");
    if (/\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(h.m[1])) at(h, "external script");
  }
  for (const h of findAll(html, /<style\b/i)) at(h, "<style> tag");
  for (const h of findAll(html, /<[a-z][^>]*\sstyle\s*=/i)) at(h, "style= attribute");
  for (const h of findAll(html, /<[a-z][^>]*\son[a-z]+\s*=/i)) at(h, "inline on…= event handler");
  for (const h of findAll(html, /javascript:/i)) at(h, "javascript: URL");
  for (const h of findAll(html, /<(iframe|object|embed|base)\b/i)) at(h, `<${h.m[1]}> tag`);
  for (const h of externalUrls(raw)) at(h, `external URL ${h.match}`);
  for (const h of protocolRelative(html)) at(h, "protocol-relative URL");
  return v;
}

function lintCss(file) {
  const raw = readFileSync(file, "utf8");
  const css = stripCssComments(raw);
  const v = [];
  for (const h of externalUrls(raw)) v.push(`${rel(file)}:${h.line} external URL ${h.match}`);
  for (const h of protocolRelative(css)) v.push(`${rel(file)}:${h.line} protocol-relative URL`);
  for (const h of findAll(css, /expression\s*\(|javascript:|-moz-binding|(?<![\w-])behavior\s*:/i)) v.push(`${rel(file)}:${h.line} scriptable CSS (${h.match})`);
  for (const h of findAll(css, /@import\b/i)) v.push(`${rel(file)}:${h.line} @import (link stylesheets from index.html instead)`);
  return v;
}

test("lint scans the app's JS modules", () => {
  assert.ok(jsFiles.some((f) => f.endsWith("crypto.js")), "found js/");
});

test("JS: no HTML injection sinks, no eval, no external hosts, storage rules", () => {
  const v = jsFiles.flatMap(lintJs);
  assert.deepEqual(v, [], "\n" + v.join("\n"));
});

test("HTML: no inline script/style, no style= or on…= attributes, no external hosts", (t) => {
  if (!htmlFiles.length) return t.skip("index.html not created yet");
  const v = htmlFiles.flatMap(lintHtml);
  assert.deepEqual(v, [], "\n" + v.join("\n"));
});

test("HTML: CSP meta tag matches CONTRACT.md and the module entry point is used", (t) => {
  if (!htmlFiles.length) return t.skip("index.html not created yet");
  const html = readFileSync(htmlFiles[0], "utf8");
  const tag = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
  const m = tag && (tag[0].match(/\bcontent="([^"]+)"/) || tag[0].match(/\bcontent='([^']+)'/));
  assert.ok(m, "index.html has a CSP <meta http-equiv> tag");
  const norm = (s) => s.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean).sort().join("; ");
  assert.equal(norm(m[1]), norm(CSP));
  assert.match(html, /<script\s+type=["']module["']\s+src=["']\.?\/?js\/main\.js["']/);
  assert.match(html, /<link[^>]+rel=["']manifest["'][^>]+href=["']\.?\/?manifest\.webmanifest["']|<link[^>]+href=["']\.?\/?manifest\.webmanifest["'][^>]+rel=["']manifest["']/);
});

test("CSS: no external hosts, imports or scriptable CSS", () => {
  const v = cssFiles.flatMap(lintCss);
  assert.deepEqual(v, [], "\n" + v.join("\n"));
});

test("_headers carries the contract CSP plus frame-ancestors", () => {
  const h = readFileSync(join(APP, "_headers"), "utf8");
  const line = h.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  assert.ok(line);
  const val = line.split(":").slice(1).join(":").trim();
  assert.ok(val.startsWith(CSP), "CSP in _headers starts with the contract CSP");
  assert.match(val, /frame-ancestors 'none'/);
  for (const k of ["X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "X-Frame-Options: DENY", "Cross-Origin-Opener-Policy: same-origin"]) assert.ok(h.includes(k), k);
});

// Self-test so the rules can't silently rot.
test("lint rules catch known-bad snippets", () => {
  const bad = [
    'el.innerHTML = x;', 'el.outerHTML = x', 'el.insertAdjacentHTML("beforeend", x)', 'document.write("x")',
    'eval("1")', 'const f = new Function("return 1")', 'el.setAttribute("style", "color:red")',
    'localStorage.setItem("profile", name)', 'localStorage.setItem(k, name)', 'const PK = { a: "wc.a", b: "name" }; localStorage.getItem(PK[k])', 'localStorage.foo = 1', 'sessionStorage.setItem("wc.a", 1)',
    'fetch("https://evil.example/x")', 'indexedDB.open("x")',
  ];
  for (const b of bad) {
    const code = stripJsComments(b);
    const hits = JS_RULES.some(([re]) => re.test(code)) || externalUrls(b).length || lintLocalStorage("x.js", code).length || /\bindexedDB\b/.test(code);
    assert.ok(hits, `should flag: ${b}`);
  }
  const good = ['localStorage.setItem("wc." + k, v)', 'const PK = { a: "wc.a" }; localStorage.getItem(PK[k])', 'for (const k of Object.keys(localStorage)) if (k.startsWith("wc.")) localStorage.removeItem(k)', '// never use innerHTML here', 'el.textContent = x', 'localStorage.setItem("wc.sound", "1")', 'const K = "wc.read"; localStorage.getItem(K)', 'document.createElementNS("http://www.w3.org/2000/svg", "svg")', 'const s = "a // b"; el.className = s'];
  for (const g of good) {
    const code = stripJsComments(g);
    const hits = JS_RULES.filter(([re]) => re.test(code)).map(([, n]) => n);
    assert.deepEqual([...hits, ...externalUrls(g).map((h) => h.match), ...lintLocalStorage("x.js", code)], [], `should allow: ${g}`);
  }
});
