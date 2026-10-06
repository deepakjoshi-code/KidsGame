# Wish Circle security and privacy

Wish Circle holds children's names, stories, drawings and photos of their books. This page
explains in plain language what the app protects against, what it can't protect against, and how
it works.

## The short version

- Everything stays **on the device**. There are no servers, accounts, analytics, ads, third-party
  scripts, fonts or CDNs. The app never sends a child's data anywhere.
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
| **Data leaking over the network** | The CSP sets `connect-src 'self'` and allows no third-party origins at all, so even injected code would have nowhere to send data. The service worker caches only the app's own files and never touches stories or photos. |
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

## Reporting a problem

Please report security issues privately through the repository's **Security → Report a
vulnerability** (GitHub private vulnerability reporting). Don't open a public issue. Never include a
child's real data, backups or photos in a report. A made-up story that shows the problem is
perfect. We aim to reply within a week.
