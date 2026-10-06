# Wish Circle comic reader (Cloudflare Worker)

A small server that lets Wish Circle's **"Build games with Claude AI"** setting work. When a child
adds a finished comic, the app shrinks the comic's panels (at most 1024 px each) and sends them
here. The Worker asks Anthropic's Claude (`claude-opus-5-5`) **once** to read the whole comic:
every speech bubble, caption and sound word with who says it, the characters (with boxes around
each one so the app can cut them out of the drawings), where each panel happens, the chapters, and
the game's levels. The app checks the answer and builds the game on the device.

- Your Anthropic API key lives only here, as a Worker **secret**. It is never in the app.
- Only your family can use it: every request needs the **family code** you choose (a second
  secret), and the app's address must be on the allow-list.
- It stores nothing. Pictures and words are never logged or saved; logs only hold counts, sizes,
  timings and status codes.

## API

| | |
|---|---|
| `POST /v1/comic` | body `{ "panels": [{ "index": 1, "jpegBase64": "…" }, …], "titleHint": "optional" }`, header `X-Family-Code`. Up to 60 panels, 12 MB per request, each a JPEG ≤ 1024 px on its long side. Answer: `{ title, cast, panels, plan, model, usage }`. With `Accept: application/x-ndjson` the answer streams as lines: `{"type":"progress",…}` while Claude reads (keeps the connection alive; it can take a few minutes), then `{"type":"result",…}` or `{"type":"error",…}`. |
| `POST /v1/check` | header `X-Family-Code` → `{ "ok": true }` (no Claude call; the app's "Test connection"). |
| `GET /v1/health` | `{ "ok": true }` |

Errors are JSON: `{ "error": { "code": "family_code", "message": "…" } }` with codes such as
`origin` (403), `family_code` (401), `rate_limited` (429), `too_big` (413), `bad_image` (400),
`refused` (422), `too_long`, `bad_output`, `upstream` (502), `busy`, `not_configured` (503).

## Deploy (one time, about 10 minutes)

You need: a Cloudflare account with **rawrbooks.com** on it, an Anthropic API key from
<https://console.anthropic.com> (Settings → API keys), and Node.js 20 or newer.

```sh
cd worker
npm i
npx wrangler login                          # opens the browser to sign in to Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY   # paste your Anthropic key (sk-ant-…)
npx wrangler secret put FAMILY_CODE         # choose a long secret, e.g. 4–5 random words
npx wrangler deploy
```

`wrangler deploy` also connects the custom domain **api.rawrbooks.com** (the `routes` entry in
`wrangler.toml`, `custom_domain = true`): Cloudflare creates the DNS record and certificate for
it on your rawrbooks.com zone. If you'd rather do it by hand: Cloudflare dashboard → Workers &
Pages → `wish-circle-comic` → Settings → Domains & Routes → Add → Custom domain →
`api.rawrbooks.com`.

Check it: `curl https://api.rawrbooks.com/v1/health` → `{"ok":true}`.

Then in the app: **Grown-ups → ✨ Build games with Claude AI** → tick the agreement box → type
the same family code → turn it on → **Test connection**. Add a finished comic from a child's shelf
and the game is made automatically.

Good to know:

- **Cost.** One comic is one Claude call (Claude Opus 5.5, high effort). A 25-panel comic is
  roughly 40–60k input tokens and 10–25k output tokens, i.e. well under a dollar. Set a monthly
  spend limit in the Anthropic Console (Settings → Limits) as a backstop.
- **Limits.** Per IP: 3 comics a minute (Workers Rate Limiting, `BOOK_LIMITER`), 10 an hour
  (`BOOKS_PER_HOUR`, best effort), and 10 code checks a minute (`CHECK_LIMITER`). Rate limits
  count before the family code is checked, so guessing codes is slow.
- **Plan.** The Workers Paid plan is recommended: reading a 12 MB request takes more CPU than the
  free plan's 10 ms per request allows for big comics.
- **Refusals.** Requests opt into Anthropic's server-side fallbacks (`fallbacks: "default"`,
  beta `server-side-fallback-2026-07-01`): if Claude declines, a fallback model is tried in the
  same call. If every model declines, the app makes the simpler on-device game instead.
- **Other app addresses.** The allow-list is `ALLOWED_ORIGINS` in `wrangler.toml`
  (https://rawrbooks.com, https://www.rawrbooks.com, https://deepakjoshi-code.github.io,
  http://localhost:8000). Change it and run `npx wrangler deploy` again.
- **Change the family code:** `npx wrangler secret put FAMILY_CODE`, then type the new one in
  Grown-ups on each device.
- **Turn it off:** in Grown-ups (per device), or `npx wrangler delete` to remove the Worker.

## Try it without an API key (MOCK mode)

`MOCK=1` answers without calling Claude: with the reading in `MOCK_RESPONSE` (a JSON string in
the same shape Claude returns) when set, or else a made-up story that fits any number of panels.
The answer goes through all the same checks. Put the settings in a file outside git, for
example `../../mock.env`:

```sh
MOCK=1
FAMILY_CODE=test-family-code
MOCK_DELAY_MS=2000
# MOCK_RESPONSE={"title":"…","cast":[…],"panels":[…],"levels":[…]}
```

```sh
npx wrangler dev --port 8787 --env-file ../../mock.env   # works offline
curl -X POST -H 'x-family-code: test-family-code' http://127.0.0.1:8787/v1/check
```

The app only talks to `https://api.rawrbooks.com` (its Content-Security-Policy allows nothing
else), so to point a local app at a local Worker, route that address to it in your test browser
(the end-to-end test does this with Playwright's `page.route`).

## Files

- `src/index.js`: routes, CORS, family code, limits, the Claude call (structured output,
  streaming, refusal / `max_tokens` handling, typed SDK errors) and logging.
- `src/prompt.js`: the system prompt (with a worked example in words, from a made-up comic).
- `src/schema.js`: the structured-output schema (zod) and limits; places, characters, weapons and
  treasure come from the app's `app/js/catalog.js`.
- `src/plan.js`: checks and repairs Claude's reading and builds the game plan.
- `src/jpeg.js`: checks each panel is a JPEG and reads its size.
- `src/mock.js`: MOCK mode.
- Tests: `app/tests/worker.test.mjs` (`cd app && npm test`, after `npm i` here).
