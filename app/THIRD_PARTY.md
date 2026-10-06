# Third-party code

Wish Circle has no runtime dependencies except the one below. It is copied into `vendor/` (no CDN,
no package manager at runtime), served from the app's own origin, precached by `sw.js`, and
loaded only when a parent picks a PDF to import. `tests/importbook.test.mjs` checks that every
file under `vendor/` is listed here and that its SHA-256 matches.

## PDF.js (Mozilla)

| | |
|---|---|
| Package | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) **5.4.624**, *legacy* build |
| Licence | Apache License 2.0 (`vendor/pdfjs/LICENSE`); the legacy build also bundles core-js polyfills (MIT, notice kept in the file header) |
| Source | https://github.com/mozilla/pdf.js (tag `v5.4.624`) |
| Tarball | https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-5.4.624.tgz |
| Tarball integrity | `sha512-sm6TxKTtWv1Oh6n3C6J6a8odejb5uO4A4zo/2dgkHuC0iu8ZMAXOezEODkVaoVp8nX1Xzr+0WxFJJmUr45hQzg==` (sha1 `f00911beb481de998c29e8e464b88d500cb1f4a8`), checked against the npm registry |
| Used by | `js/importbook.js` (PDF import only) |

| File in the app | Copied from (in the tarball) | Bytes | SHA-256 |
|---|---|---|---|
| `vendor/pdfjs/pdf.min.js` | `package/legacy/build/pdf.min.mjs` | 481423 | `246b088f414359637e6403753a1e815caa4bd20e9c645be4b5ef4c89f405aafa` |
| `vendor/pdfjs/pdf.worker.min.js` | `package/legacy/build/pdf.worker.min.mjs` | 1128591 | `88b29a656ecf0b104c2ef1b620be099c523be2a57f27fbb8a42bdac6b8c9a4c0` |
| `vendor/pdfjs/LICENSE` | `package/LICENSE` | 10174 | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

The files are byte-for-byte identical to the upstream ones. Only the extension was changed from
`.mjs` to `.js`, so every static host and old `python3 -m http.server` versions serve them as
JavaScript (browsers refuse module scripts served with a non-JavaScript MIME type).

### Why this version and build

- **Legacy build**: the modern build is not transpiled and needs the very newest browsers
  (`Map.prototype.getOrInsertComputed`, `Math.sumPrecise`, …). The legacy build is
  Babel-compiled with core-js polyfills.
- **5.4.624, not 6.x**: PDF.js 5.x targets *Safari ≥ 16.4* (iOS/iPadOS 16.4+, so all of iOS 17);
  6.x raised that to *Safari ≥ 18*. No PDF.js release with the CVE-2024-4367 fix
  (GHSA-wgrm-67xf-hhpq, fixed in 4.2.67) supports Safari 15, so iOS 15 and iOS 16.0–16.3 can't
  import PDFs: the importer says so in plain words and suggests adding page photos instead.
  `npm audit` data shows no advisories for 5.4.624.

### What is deliberately not vendored

| Upstream folder | What it's for | Trade-off |
|---|---|---|
| `standard_fonts/` | Glyph data for the 14 standard PDF fonts when they aren't embedded | `useSystemFonts: true` uses the device's own Helvetica/Times/Courier instead. Text extraction doesn't need it. |
| `cmaps/` | Predefined CMaps for CJK fonts | Pages still render (fonts are usually embedded); text extraction from CJK PDFs using predefined CMaps may come out empty. |
| `wasm/` | JPEG 2000, JBIG2 and ICC colour decoders | `useWasm: false`. The app's CSP has no `'wasm-unsafe-eval'`, so WebAssembly couldn't run anyway. ICC colour falls back to plain RGB. JPEG 2000/JBIG2 images (rare in phone/scanner PDFs) may be blank. |
| `pdf.sandbox`, `web/`, `image_decoders/`, source maps | Form scripting, the PDF viewer UI, standalone decoders, debugging | Not needed; PDF JavaScript is never run. |

### Updating

1. `npm pack pdfjs-dist@<version>` in a temporary folder and check the tarball integrity against
   `npm view pdfjs-dist@<version> dist.integrity`.
2. Check `ENV_TARGETS` in that tag's `gulpfile.mjs` still includes the Safari versions we support.
3. Copy the three files above (renaming `.mjs` → `.js`), update this table (sizes and SHA-256),
   bump `VERSION` in `sw.js`, and run `npm test` plus the PDF import check in a browser.
