# Wish Circle app: work in progress (paused)

Paused mid-build. Done so far (untested):
- `js/catalog.js`: characters, places, game kinds, keyword lists
- `js/story.js`: story text → book (pages, cast, places, actions) → game plan
- `js/crypto.js`: passcode vault (PBKDF2 600k → AES-256-GCM), sealed records
- `js/store.js`: encrypted IndexedDB store, lockout, backup/restore, wipe
- `js/ui.js`, `js/audio.js`, `js/images.js`, `js/art.js`

Still to do: game engine/levels, screens (setup, unlock, profiles, shelf, editor,
comic + print, parent area), index.html + CSS, manifest + service worker + icons,
CSP/_headers, unit + e2e tests, Pages deploy, Mousie book-pack import file.
