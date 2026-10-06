# Wish Circle: build contract

Wish Circle is an installable web app (PWA) for iPhone, iPad and Mac. A child (with a parent's help)
types or photographs their own story book. The app turns it into **comic pages** they can read
aloud and print, and a **game**: the comic pages play in order, and each action moment in the story
(a journey, a battle, a treasure hunt, a climb, meeting friends, a celebration) becomes a short
level with big buttons. Each child has their own profile. It was inspired by "Mousie", a comic
by a 6-year-old.

## Non-negotiables

- **Local-first and private.** No servers, accounts, analytics, third-party scripts, fonts or
  CDNs. Nothing a child makes ever leaves the device, except for an encrypted backup or a book the
  parent explicitly exports.
- **Encrypted at rest.** Everything goes through `js/store.js`: a parent passcode → PBKDF2-SHA-256
  (600k) → wraps an AES-256-GCM data key. IndexedDB holds only `{id, iv, ct}`. Never write user
  data to localStorage, sessionStorage or IndexedDB directly. The only exception is
  non-identifying UI preferences in localStorage (sound on/off).
- **No HTML injection.** Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval` or `new Function`. Build DOM with `h()` from `js/ui.js` (text goes in
  through text nodes). Set styles through `el.style`/classes, never `setAttribute("style")`.
- **CSP** (meta tag in index.html, plus `_headers` for hosts):
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
  No inline `<script>` or `<style>` and no `style=` attributes in HTML.
- **No build step.** Plain ES modules (`<script type="module" src="js/main.js">`), served as static
  files. It must work from any static host over HTTPS and from `python3 -m http.server`.
- **Kids first.** Big buttons (at least 64px tap targets for child screens), read-aloud, icons with
  labels, no failure states in games, and no ads or links out. Parent-only areas sit behind the
  passcode.
- **Phones.** Works upright and sideways on iPhone SE (375×667) to Pro Max (440×956), iPad and Mac.
  Respect safe areas (`env(safe-area-inset-*)`), use `100dvh`, and no horizontal scroll.
- **Look.** A warm storybook-paper look (cream paper, dark brown ink, chunky outlined buttons).
  Fonts are system faces only: `"Chalkboard SE", "Comic Sans MS", "Marker Felt", cursive` for
  display, and `system-ui` for body text.

## Existing modules (read them; don't rewrite)

| file | what | owner for edits |
|---|---|---|
| `js/catalog.js` | characters (emoji), places, game kinds, keyword lists, avatars, colours, lock pictures | integrator only |
| `js/story.js` | `buildBook(text, {title, author})`, `planGame(book)`, `EXAMPLE_STORY`, `newId()` | integrator only |
| `js/crypto.js` | vault, seal/open, passcode rules, picture-lock hash | Screens agent (bug fixes only) |
| `js/store.js` | encrypted store: setup/unlock/lock/verify/save/get/list/remove, images, backup, wipe | Screens agent |
| `js/ui.js` | `h`, `show`, `button`, `topbar`, `toast`, `dialog`, `confirmBox`, `askPasscode`, `saveFile`, `pickFile` | Screens agent |
| `js/audio.js` | `sfx.*`, `speak(lines, onLine)`, `say`, `stopSpeech`, `settings` | Game agent |
| `js/images.js` | `pagePhoto(file)`, `spriteFromDrawing(file)`, `loadImage(url)`, `fromDataURL()` | Screens agent |
| `js/art.js` | `loadSprites(book)`, `drawSprite`, `drawEmoji`, `drawScene`, `groundY`, `layoutActors`, `renderPanel(page, sprites, W, H)` | Comic agent |

Other agents may not edit a module they don't own. If you need a change in one, implement a local
helper in your own file and mention it in your report.

## Book object (decrypted record, `kind: "book"`)

```js
{ id, kind: "book", profileId, title, author, created, updated,
  stars, plays, cover /* imageId|null */,
  cast: [{ id, name, emoji, kind /* catalog key|null */, faces, flip, imageId /* drawing|null */, role /* hero|friend|villain */, big, words }],
  pages: [{ id, imageId /* photo of the child's page|null */, place /* PLACES key */, narration, lines: [{ who /* cast id */, text }], actors: [castId], action /* ACTIONS key|"none" */ }] }
```

Profile: `{ id, kind: "profile", name, avatar /* emoji */, color, age, lock: null | { salt, hash } }`.

## Module interfaces (new)

- **Game agent** → `js/game.js`: `export async function playGame(book, { onExit, onFinish })`.
  It renders full-screen into `#app` (via `ui.show`), plays `planGame(book)` steps, and calls
  `onFinish(starsEarned)` at the end and `onExit()` on Back. Story steps show the comic panel for
  that page (`art.renderPanel`) with speech bubbles and read-aloud. Level steps play mini-games:
  `journey`, `battle`, `collect`, `climb`, `friends`, `celebrate`. Styles live in
  `css/game.css`.
- **Comic agent** → `js/comic.js`:
  - `export async function showComic(book, { onBack, onPlay, onEdit })`: a comic reader (panels,
    bubbles, narration captions, page turn, read-aloud) and a Print layout (`css/print.css`,
    `window.print()`).
  - `export async function exportBookPack(book)`: returns a JSON string, a portable unencrypted
    `.wishbook` with images as data URLs.
  - `export async function importBookPack(text, profileId)`: validates strictly, re-encodes images
    through `images.js`, saves through `store`, and returns the saved book.
  - Styles live in `css/comic.css`.
- **Screens agent** → `index.html`, `css/app.css`, `js/main.js`, `js/screens/*.js`. This covers
  setup, unlock, auto-lock, profile picker, picture lock, bookshelf, story editor (write, photos,
  review cast and pages), parent area (profiles, backup and restore, change passcode, import and
  export books, wipe, privacy explainer) and routing. It calls `playGame` and `showComic`, and
  links `css/app.css`, `css/game.css`, `css/comic.css`, `css/print.css`.
- **Platform agent** → `manifest.webmanifest`, `sw.js`, `icons/*`, `_headers`, `tests/*`,
  `package.json` (test scripts only, no dependencies) and `.github/workflows/*`.

`main.js` registers `sw.js` (scope `./`) only when served over HTTPS or from localhost.
