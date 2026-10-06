// Wish Circle comic reader: a Cloudflare Worker that sends a child's comic panels to Claude once
// and returns the comic as data (cast, words per panel, places, chapters) plus a game plan.
//
//   POST /v1/comic   { panels: [{ index, jpegBase64 }], titleHint? }  → { title, cast, panels, plan, model, usage }
//                    With "Accept: application/x-ndjson" the answer streams as lines:
//                    {type:"progress",...} … then {type:"result",...} or {type:"error",...}.
//   POST /v1/check   checks the family code (no Claude call)  → { ok: true }
//   GET  /v1/health  → { ok: true }
//
// Privacy: pictures and words are never logged or stored. Logs carry counts, sizes, timings and
// status only. Secrets: ANTHROPIC_API_KEY and FAMILY_CODE (wrangler secret put).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ComicReading, MODEL, MAX_PANELS, MAX_BODY_BYTES, MAX_SIDE, MIN_SIDE } from "./schema.js";
import { SYSTEM_PROMPT, userContent } from "./prompt.js";
import { shapeReading, cleanText } from "./plan.js";
import { jpegSize } from "./jpeg.js";
import { mockClient } from "./mock.js";

export const DEFAULT_ORIGINS = ["https://rawrbooks.com", "https://www.rawrbooks.com", "https://deepakjoshi-code.github.io", "http://localhost:8000"];
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 64000;
const HEARTBEAT_MS = 10000;

// Friendly messages the app can show a parent as they are.
const ERRORS = {
  not_found: [404, "There's nothing here."],
  method: [405, "Use POST for this."],
  origin: [403, "This website isn't allowed to use the comic reader."],
  family_code: [401, "The family code doesn't match. Check it in Grown-ups."],
  not_configured: [503, "The comic reader isn't set up yet (its secrets are missing)."],
  rate_limited: [429, "That's a lot of comics for now. Please try again a bit later."],
  too_big: [413, "That comic is too big to send in one go."],
  bad_request: [400, "The comic couldn't be read from this request."],
  bad_image: [400, "One of the pictures isn't a JPEG the reader can use."],
  refused: [422, "Claude couldn't make a game from this comic."],
  too_long: [502, "This comic was too long for Claude to finish in one go."],
  bad_output: [502, "Claude's answer didn't make sense this time. Please try again."],
  busy: [503, "Claude is very busy right now. Please try again in a few minutes."],
  upstream: [502, "The comic reader couldn't reach Claude. Please try again."],
  upstream_auth: [502, "The comic reader's Claude key isn't working. A grown-up needs to check the Worker's secrets."],
  upstream_rejected: [502, "Claude couldn't accept these pictures."],
  cancelled: [499, "Cancelled."],
};
class Fail extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; }
}

const encoder = new TextEncoder();
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
});
const errorBody = (code, extra = {}) => ({ error: { code, message: ERRORS[code]?.[1] || "Something went wrong.", ...extra } });

function allowedOrigins(env) {
  const raw = typeof env.ALLOWED_ORIGINS === "string" && env.ALLOWED_ORIGINS.trim() ? env.ALLOWED_ORIGINS.split(",") : DEFAULT_ORIGINS;
  return new Set(raw.map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean));
}
function corsHeaders(origin) {
  return origin ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-expose-headers": "content-type" } : { vary: "Origin" };
}

/** Constant-time comparison: both sides are hashed to 32 bytes first, so length leaks nothing. */
export async function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function readCapped(request, max) {
  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new Fail("too_big");
  if (!request.body) throw new Fail("bad_request");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* gone */ } throw new Fail("too_big"); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** The request body → [{ index, width, height, jpegBase64 }] and a safe title hint. */
export function parseComicRequest(text) {
  let body;
  try { body = JSON.parse(text); } catch { throw new Fail("bad_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.panels)) throw new Fail("bad_request");
  if (!body.panels.length) throw new Fail("bad_request");
  if (body.panels.length > MAX_PANELS) throw new Fail("too_big", { maxPanels: MAX_PANELS });
  const seen = new Set();
  const panels = body.panels.map((p) => {
    if (!p || typeof p !== "object" || !Number.isInteger(p.index) || p.index < 0 || p.index > 9999 || seen.has(p.index)) throw new Fail("bad_request");
    seen.add(p.index);
    const size = jpegSize(p.jpegBase64);
    if (!size) throw new Fail("bad_image", { panel: p.index });
    if (Math.max(size.width, size.height) > MAX_SIDE || Math.min(size.width, size.height) < MIN_SIDE) throw new Fail("bad_image", { panel: p.index, maxSide: MAX_SIDE });
    return { index: p.index, width: size.width, height: size.height, jpegBase64: p.jpegBase64 };
  });
  const titleHint = cleanText(typeof body.titleHint === "string" ? body.titleHint : "", 80).replace(/["“”<>\\]/g, "");
  return { panels, titleHint };
}

// Coarse per-IP hourly cap on books, kept in the colo's cache (best effort; the Rate Limiting
// binding is the strict per-minute guard). Skipped when the Cache API isn't available.
async function hourlyAllowed(env, ip) {
  const limit = Number(env.BOOKS_PER_HOUR ?? 10);
  if (!(limit > 0) || typeof caches === "undefined" || !caches.default) return true;
  const hour = Math.floor(Date.now() / 3600000);
  const key = new Request(`https://rate.invalid/books/${hour}/${encodeURIComponent(ip)}`);
  try {
    const hit = await caches.default.match(key);
    const n = hit ? Number(await hit.text()) || 0 : 0;
    if (n >= limit) return false;
    await caches.default.put(key, new Response(String(n + 1), { headers: { "cache-control": "max-age=3600" } }));
  } catch { /* the binding still guards */ }
  return true;
}

function defaultClient(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 15 * 60 * 1000 });
}

// The JSON schema Claude must follow (generated from the zod schema by the SDK). The SDK's own
// parse hook is left out so a cut-off or refused answer never throws before stop_reason is read;
// the Worker parses and validates the text itself.
const { parse: _sdkParse, ...OUTPUT_FORMAT } = betaZodOutputFormat(ComicReading);

/**
 * Ask Claude once. → { reading, model, usage } or throws Fail.
 * onProgress({ stage, done?, total? }) is called while it reads and writes.
 */
export async function readComic(client, input, titleHint, { signal, onProgress = () => {}, log = () => {} } = {}) {
  let stream;
  try {
    stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "high", format: OUTPUT_FORMAT },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent(input, titleHint) }],
    }, { signal });
    let thinking = false, lastDone = -1;
    stream.on("thinking", () => { if (!thinking) { thinking = true; onProgress({ stage: "thinking" }); } });
    stream.on("text", (_delta, snapshot) => {
      // The answer lists the panels in order, so counting finished panel entries is the progress.
      const done = Math.min(input.length, (snapshot.match(/"part"\s*:/g) || []).length);
      if (done !== lastDone) { lastDone = done; onProgress({ stage: "writing", done, total: input.length }); }
    });
    const msg = await stream.finalMessage();
    return finish(msg, input, log);
  } catch (e) {
    if (e instanceof Fail) throw e;
    if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) throw new Fail("cancelled");
    if (e instanceof Anthropic.RateLimitError) throw new Fail("busy");
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new Fail("upstream_auth");
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError) throw new Fail("upstream_rejected");
    if (e instanceof Anthropic.APIConnectionError) throw new Fail("upstream");
    if (e instanceof Anthropic.APIError) throw new Fail(e.status === 529 || e.status === 503 ? "busy" : "upstream");
    throw new Fail("upstream");
  }
}

function finish(msg, input, log) {
  const fallback = (msg.usage?.iterations || []).some((it) => it?.type === "fallback_message");
  const usage = { input_tokens: msg.usage?.input_tokens ?? 0, output_tokens: msg.usage?.output_tokens ?? 0, fallback };
  const meta = { stop: msg.stop_reason, model: msg.model, ...usage };
  if (msg.stop_reason === "refusal") {
    // stop_details is only set for refusals; only its category is kept (never the text).
    const category = msg.stop_details?.category ?? null;
    log({ ...meta, category });
    throw new Fail("refused", { category });
  }
  if (msg.stop_reason === "max_tokens") { log(meta); throw new Fail("too_long"); }
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let raw;
  try { raw = JSON.parse(text); } catch { log({ ...meta, parse: false }); throw new Fail("bad_output"); }
  const strict = ComicReading.safeParse(raw);
  let reading;
  try { reading = shapeReading(raw, input); } catch { log({ ...meta, schema: strict.success }); throw new Fail("bad_output"); }
  log({ ...meta, schema: strict.success, cast: reading.cast.length, levels: reading.plan.filter((s) => s.type === "level").length });
  return { reading, model: msg.model, usage };
}

/**
 * Build the Worker. Tests pass a fake `makeClient`, a fake `log`, and fake env bindings.
 * makeClient(env, input) → an object with beta.messages.stream(params, { signal }).
 */
export function createHandler({ makeClient = defaultClient, log = (o) => console.log(JSON.stringify(o)) } = {}) {
  return async function fetchHandler(request, env = {}, ctx = {}) {
    const t0 = Date.now();
    const url = new URL(request.url);
    const origin = (request.headers.get("origin") || "").replace(/\/+$/, "");
    const allowed = allowedOrigins(env);
    const originOk = !origin || allowed.has(origin);
    const cors = corsHeaders(origin && originOk ? origin : null);
    const fail = (code, extra) => json(ERRORS[code]?.[0] || 500, errorBody(code, extra), cors);
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const done = (status, more = {}) => log({ event: "request", route, status, ms: Date.now() - t0, ...more });

    if (request.method === "OPTIONS") {
      if (!origin || !originOk) { done(403); return new Response(null, { status: 403, headers: { vary: "Origin" } }); }
      done(204);
      return new Response(null, {
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type, x-family-code, accept", "access-control-max-age": "86400" },
      });
    }
    if (!originOk) { done(403); return fail("origin"); }
    if (route === "/v1/health" && request.method === "GET") { done(200); return json(200, { ok: true }, cors); }
    if (route !== "/v1/comic" && route !== "/v1/check") { done(404); return fail("not_found"); }
    if (request.method !== "POST") { done(405); return fail("method"); }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    // Rate limit before checking the code, so guessing codes is slow too.
    const limiter = route === "/v1/comic" ? env.BOOK_LIMITER : env.CHECK_LIMITER;
    if (limiter && typeof limiter.limit === "function") {
      let ok = true;
      try { ({ success: ok } = await limiter.limit({ key: ip })); } catch { ok = true; }
      if (!ok) { done(429); return fail("rate_limited"); }
    }
    if (!env.FAMILY_CODE || (env.MOCK !== "1" && !env.ANTHROPIC_API_KEY)) { done(503); return fail("not_configured"); }
    if (!(await sameSecret(request.headers.get("x-family-code") || "", env.FAMILY_CODE))) { done(401); return fail("family_code"); }
    if (route === "/v1/check") { done(200); return json(200, { ok: true, model: MODEL, mock: env.MOCK === "1" }, cors); }

    // ---- POST /v1/comic
    if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) { done(400); return fail("bad_request"); }
    let input, titleHint, bytes = 0;
    try {
      const text = await readCapped(request, MAX_BODY_BYTES);
      bytes = text.length;
      ({ panels: input, titleHint } = parseComicRequest(text));
    } catch (e) {
      const code = e instanceof Fail ? e.code : "bad_request";
      done(ERRORS[code][0], { bytes });
      return fail(code, e.extra);
    }
    if (!(await hourlyAllowed(env, ip))) { done(429, { panels: input.length }); return fail("rate_limited"); }

    const client = env.MOCK === "1" ? mockClient(env, input) : makeClient(env, input);
    const signal = request.signal;
    const meta = { panels: input.length, bytes };
    const claudeLog = (o) => log({ event: "claude", ...meta, ...o, ms: Date.now() - t0 });
    const answer = (r) => ({ ...r.reading, model: r.model, usage: r.usage });

    const wantsStream = /application\/x-ndjson/i.test(request.headers.get("accept") || "");
    if (!wantsStream) {
      try {
        const r = await readComic(client, input, titleHint, { signal, log: claudeLog });
        done(200, meta);
        return json(200, answer(r), cors);
      } catch (e) {
        const code = e instanceof Fail ? e.code : "upstream";
        done(ERRORS[code][0], meta);
        return fail(code, e.extra);
      }
    }

    // Streaming: progress lines keep the connection busy while Claude reads (it can take minutes).
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let open = true;
    const send = (obj) => { if (!open) return Promise.resolve(); return writer.write(encoder.encode(JSON.stringify(obj) + "\n")).catch(() => { open = false; }); };
    const job = (async () => {
      let stage = "reading";
      const beat = setInterval(() => { send({ type: "progress", stage }); }, HEARTBEAT_MS);
      await send({ type: "progress", stage, done: 0, total: input.length });
      try {
        const r = await readComic(client, input, titleHint, {
          signal, log: claudeLog,
          onProgress: (p) => { stage = p.stage; send({ type: "progress", ...p }); },
        });
        await send({ type: "result", ...answer(r) });
        done(200, meta);
      } catch (e) {
        const code = e instanceof Fail ? e.code : "upstream";
        await send({ type: "error", status: ERRORS[code][0], ...errorBody(code, e.extra) });
        done(ERRORS[code][0], meta);
      } finally {
        clearInterval(beat);
        open = false;
        try { await writer.close(); } catch { /* client went away */ }
      }
    })();
    ctx.waitUntil?.(job);
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...cors },
    });
  };
}

export default { fetch: createHandler() };
