# Wish Circle security and privacy

Wish Circle holds children's names, stories, drawings and photos of their books. This page
explains in plain language what the app protects against, what it can't protect against, and how
it works.

## The short version

- Everything stays **on the device**. There are no accounts, analytics, ads, third-party
  scripts, fonts or CDNs. The app never sends a child's data anywhere, with one opt-in exception:
  if a parent turns on **Build games with Claude AI**, the pictures of a finished comic being
  added are sent to the family's own comic reader and on to Anthropic's Claude (see below).
- Everything is **encrypted at rest** with a key that only the parent's passcode can unlock.
- **If you forget the passcode, the data can't be recovered.** Not by us, not by anyone. Keep the
  passcode somewhere safe and save backups.

## What is protected

| Threat | Protection |
|---|---|
| **A lost, stolen or shared device**, or someone copying the browser's files | IndexedDB only ever holds random ids, IVs and AES-GCM ciphertext. Profile names, stories, drawings and photos are all inside the ciphertext. Without the passcode, the data is unreadable. |
| **Someone guessing the passcode in the app** | The passcode is stretched with PBKDF2-SHA-256 (600,000 rounds), so each guess is slow. After 5 wrong tries the app makes you wait 30 s, then 60 s, 120 s and so on, up to 1 hour. The app locks itself after a few idle minutes (5, 10 or 30, chosen by the parent), and when it has been in the background for more than 3 minutes. |
| **Siblings** | Each child has their own profile. An optional picture lock keeps siblings out of each other's shelves. The parent area (settings, backups, deleting things) always needs the parent passcode. |
| **Malicious imported files** (shared `.wishbook` books, backups, photos) | Imports are parsed as data and checked strictly. Every image is decoded and redrawn on a canvas, which also removes hidden metadata such as GPS location. A backup is only accepted after every record in it decrypts and passes its integrity check. |
| **Script injection** (a story containing `<script>`, odd characters and so on) | The app never turns text into HTML. No `innerHTML`, `eval` or similar is used, and the DOM is built from text nodes. A strict Content-Security-Policy allows only the app's own scripts and styles: no inline code and no other origins. A lint test enforces these rules on every change. |
| **Data leaking over the network** | The CSP sets `connect-src 'self' https://api.rawrbooks.com`: the only other origin is the family's own comic reader (used only when Claude AI is turned on), so even injected code would have nowhere else to send data. No other third-party origins are allowed. The service worker caches only the app's own files and never touches stories or photos. |
| **Records being swapped or edited on disk** | Each record is sealed with AES-256-GCM, with its id as additional authenticated data. A changed, truncated or swapped record fails to decrypt and is ignored. |

## What is not protected

- **A compromised device or browser.** Malware, a malicious browser extension or someone with
  developer tools on an *unlocked* app can read what the app shows. Keep the device updated and
  locked.
- **A weak passcode.** Someone who copies the encrypted data off the device can try passcodes
  offline as fast as their hardware allows. The in-app wait doesn't apply to them, and PBKDF2 only
  slows them down. The app rejects very weak passcodes. A short sentence is better than a short
  number.
- **A forgotten passcode.** The data is unrecoverable by design. There's no reset, recovery email
  or back door. The only way forward is to erase the app's data and start again, or restore a
  backup whose passcode you remember.
- **The picture lock is not encryption.** It only keeps siblings apart inside an app the parent has
  already unlocked. A determined child with the device can get past it. The real protection is the
  parent passcode.
- **Exported books (`.wishbook`) are not encrypted.** Exporting a book to share it is an explicit
  parent action. The file holds that book's text and pictures in plain form. Backups, by contrast,
  stay encrypted.
- **Screenshots, printing and read-aloud.** Printed comics, screenshots and the device's
  text-to-speech voices are outside the app's control. On most devices, speech runs locally.
- **Hosting without headers.** On GitHub Pages only the CSP `<meta>` tag applies, so there's no
  `frame-ancestors`/`X-Frame-Options` protection against framing. Netlify and Cloudflare Pages
  apply the full [`_headers`](_headers).

## Claude AI (optional, off by default)

Grown-ups → **✨ Build games with Claude AI** lets Anthropic's Claude read a finished comic and plan
its game. It stays off until a parent ticks the consent box, types the family code and turns it
on; the setting itself is stored encrypted like everything else.

- **What is sent, and when:** only when a child adds a finished comic while it's on, and only that
  comic's panel pictures, re-drawn as JPEGs of at most 1024 px (which also drops photo metadata),
  plus the file's name as a title hint. No child names, profiles, passcodes or other books.
- **Where:** to `https://api.rawrbooks.com`, a Cloudflare Worker the family deploys themselves
  (`worker/`). It holds the Anthropic API key as a secret (the key is never in the app), checks
  the **family code** (a second secret, compared in constant time), allows only the app's own
  web addresses (CORS allow-list), rate-limits per IP (before the code is checked, so guessing is
  slow), refuses oversized requests early, and passes the pictures to Anthropic's API in one
  request. It **stores nothing** and **logs no pictures or words**, only counts, sizes, timings
  and status codes.
- **At Anthropic:** handled under Anthropic's API terms (API inputs aren't used for training by
  default). Server-side refusal fallbacks are on, so a declined request may be answered by
  another Claude model in the same call.
- **What comes back** is treated as untrusted data: the app checks every field strictly (types,
  lengths, character ids, boxes inside the picture, known places, level kinds, weapons and
  treasure) and drops the answer if anything is off. The comic's own text is data to Claude too:
  the prompt tells it never to follow instructions written in a comic.
- **If it can't help** (offline, busy, quota, a refusal), the book is made on the device as
  before, and the parent is told gently.
- The Content-Security-Policy allows exactly this one extra address in `connect-src`.

## Crypto details

All crypto uses the browser's built-in WebCrypto (`js/crypto.js`, unit-tested in Node).

- **Key hierarchy:** a random **AES-256-GCM data key** encrypts everything. It is wrapped (AES-GCM,
  12-byte random IV, AAD `wishcircle/vault/v1`) by a **key-encryption key** derived from the passcode
  with **PBKDF2-SHA-256, 600,000 iterations, 16-byte random salt**. The passcode is NFKC-normalised
  first. The unwrapped data key is non-extractable.
- **Records and images:** each one is sealed with the data key, a fresh 12-byte random IV, and AAD
  `records/<id>` or `images/<id>`. Ids are 128-bit random hex. IndexedDB stores only
  `{ id, iv, ct }`. The vault record holds the KDF parameters, salt, IV and wrapped key.
- **Changing the passcode** re-wraps the same data key. Nothing else is re-encrypted, and the old
  passcode stops working.
- **Picture lock:** PBKDF2-SHA-256 with 100,000 iterations and a 16-byte salt over the picture
  sequence. It is stored inside the encrypted profile.
- **Not stored in plaintext anywhere:** names, titles, story text, cast, photos and drawings.
  `localStorage` holds only non-identifying UI preferences under `wc.*` keys (for example, sound
  on/off). `sessionStorage` and cookies aren't used.

## Storage, eviction and backups

Browsers may delete website data. Safari can clear data for sites you haven't opened in a few
weeks, and any browser may clear data when the device runs low on space. To keep data safe:

- **Install the app** (Add to Home Screen / Add to Dock). Installed apps are kept, and the app also
  asks the browser for persistent storage.
- **Save a backup regularly** from the parent area. A backup is the encrypted database in one file,
  so it's useless without the passcode and safe to keep in iCloud Drive or on a USB stick.
  Restoring it needs the passcode that was in use when it was made.
- "Erase everything" in the parent area deletes the database and the app's preferences. Backup
  files you saved elsewhere are not touched.

## Third-party code

The app has one third-party library: Mozilla **PDF.js** (Apache-2.0), used only to import a
child's finished book from a PDF. It's listed in [`THIRD_PARTY.md`](THIRD_PARTY.md) with its
version, source and the SHA-256 of every file, and a test fails if `vendor/` changes without that
list changing too.

- **Served from the app itself** (`vendor/pdfjs/`), never from a CDN, and precached for offline
  use. It's loaded only when a PDF is chosen and runs in a same-origin Web Worker allowed by
  `worker-src 'self'`. The CSP is unchanged.
- **No code from the PDF ever runs.** PDF JavaScript, forms (XFA) and scripting are off, and
  `isEvalSupported: false` stops PDF.js from compiling PDF functions into JavaScript (this is the
  setting that also mitigates CVE-2024-4367; the vendored version has that bug fixed anyway).
  WebAssembly is off (`useWasm: false`), so the CSP needs neither `'unsafe-eval'` nor
  `'wasm-unsafe-eval'`.
- **Nothing is fetched.** The PDF is read from the chosen file's bytes. No fonts, CMaps or other
  data files are downloaded. Missing standard fonts use the device's own fonts.
- **Nothing hidden survives.** Each page is drawn onto a fresh canvas and saved as a new JPEG, so
  the PDF's metadata, attachments and embedded photos' EXIF data are left behind. Only the page
  picture, its visible text and the title are kept.
- **Limits:** PDFs up to 100 MB, and only the first 40 pages are read. Locked (password) and
  damaged PDFs are refused with a plain message.
- **Old devices:** PDF.js needs Safari 16.4 or newer (iOS/iPadOS 16.4+). On older devices the app
  says PDFs can't be read there and suggests adding photos of the pages instead.

## Reporting a problem

Please report security issues privately through the repository's **Security → Report a
vulnerability** (GitHub private vulnerability reporting). Don't open a public issue. Never include a
child's real data, backups or photos in a report. A made-up story that shows the problem is
perfect. We aim to reply within a week.
