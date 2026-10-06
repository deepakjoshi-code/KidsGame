# Wish Circle (app)

Wish Circle turns a child's own story book into **comic pages** and a **game**.

A child (with a grown-up's help) types their story or takes photos of the pages they drew. The app
finds the characters, places and action moments. It then shows the story as comic pages with
speech bubbles that can be read aloud and printed. The same pages play as a game: each action moment
(a journey, a battle, a treasure hunt, a climb, meeting friends, a party) becomes a short level with
big buttons and no way to lose. Each child has their own profile and bookshelf.

It is a plain static web app: HTML, CSS and JavaScript modules, with no build step, no server, no
accounts, no analytics and no third-party code. Everything a child makes is encrypted on the
device with the parent's passcode. See [SECURITY.md](SECURITY.md).

## Run it on your computer

```sh
cd app
python3 -m http.server 8000
```

Open <http://localhost:8000>. Any static file server works. The service worker (offline support)
only registers over HTTPS or on `localhost`.

## Install it

The app installs like a native app and then works offline.

- **iPhone / iPad:** open the site in **Safari** → tap **Share** → **Add to Home Screen** → **Add**.
  Open it from the new icon. Installing also stops Safari from clearing the app's data after a
  few weeks without a visit.
- **Mac (Safari 17+):** open the site → **File** → **Add to Dock…**.
- **Mac / PC (Chrome or Edge):** open the site → click the **install** icon in the address bar (or
  menu → **Cast, save and share** → **Install page as app…**).

Installing needs HTTPS, so use a deployed copy (see below) or `localhost`.

## Test it

Node 20 or newer, no `npm install` needed:

```sh
cd app
npm test            # same as: node --test tests/*.test.mjs
npm run test:e2e    # browser test; needs Playwright installed globally
```

| Test | Checks |
|---|---|
| `tests/crypto.test.mjs` | vault create/open, wrong passcode, seal/open, AAD binding, tamper detection, passcode change, passcode rules, picture-lock hash |
| `tests/story.test.mjs` | page splitting, dialogue parsing, cast/places/actions, villain and battle detection, game plan rules, size limits. Tests marked `# TODO` record known gaps in `js/story.js`. |
| `tests/security-lint.test.mjs` | no `innerHTML`/`eval`/inline script or style, no external URLs, `localStorage` only for `wc.*` UI preferences, IndexedDB only via `js/store.js`, CSP in `index.html` and `_headers` |
| `tests/sw-assets.test.mjs` | the service worker's precache list matches the real runtime files exactly; manifest and icons are valid |
| `tests/e2e.mjs` | in Chromium: setup → profile → example book → comic → game → lock/unlock; no console errors or CSP violations; raw IndexedDB holds no readable names or story text; manifest; service worker; works offline |

For the end-to-end test, install Playwright once: `npm i -g playwright && npx playwright install chromium`.
The script runs `python3 -m http.server` on a free port itself. `HEADED=1 npm run test:e2e`
shows the browser. Screenshots go to your temp folder (`E2E_OUT=dir` to change that).

### When you add or rename a file

Every file the app loads must be listed in `SHELL` in `sw.js`, or the app breaks offline.
`npm test` fails and names the file. Add it to the list and bump `VERSION` in `sw.js` on every
release, so installed copies pick up the new files.

The icons are drawn by `icons/make-icons.py` (needs Pillow): `python3 -I icons/make-icons.py icons`.

## Deploying

Upload the `app/` folder to any static host with HTTPS. Leave out `tests/`, `*.md`,
`package.json` and `icons/make-icons.py` if you like, since the app doesn't use them.

- **Netlify / Cloudflare Pages:** set the publish directory to `app`, with no build command.
  Both read [`_headers`](_headers), which adds the full Content-Security-Policy (with
  `frame-ancestors 'none'`), `nosniff`, `no-referrer`, a strict `Permissions-Policy`,
  `X-Frame-Options: DENY` and cache rules (`sw.js` and `index.html` are never cached by the browser).
- **GitHub Pages:** the workflow `.github/workflows/pages.yml` runs the tests and deploys `app/` on
  every push to `main`. You can also run it by hand from the Actions tab. Turn it on in **Settings →
  Pages → Source: GitHub Actions**. Notes:
  - GitHub Pages on a **private** repository needs a paid plan (Pro, Team or Enterprise).
  - GitHub Pages **can't set custom headers** and ignores `_headers`. The CSP `<meta>` tag in
    `index.html` still applies there. Clickjacking protection (`frame-ancestors`) can't be set
    from a meta tag. The app holds nothing worth framing while it's locked, but prefer Netlify or
    Cloudflare Pages for the strongest setup.
  - The app uses relative paths throughout, so it works under `https://user.github.io/repo/`.

## Layout

```
index.html            entry point (CSP meta tag, loads js/main.js)
manifest.webmanifest  install metadata
sw.js                 offline cache of the app shell (no user data)
_headers              security headers for Netlify / Cloudflare Pages
css/                  app, game, comic and print styles
js/                   ES modules (see CONTRACT.md for who owns what)
icons/                app icons (+ make-icons.py to redraw them)
tests/                node:test unit tests + Playwright e2e
```
