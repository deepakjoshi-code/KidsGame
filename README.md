# Wish Circle

Two projects that turn a child's own story book into something they can play.

| Folder | What it is |
|---|---|
| [`app/`](app/README.md) | **Wish Circle**, an installable, private web app (PWA) for iPhone, iPad and Mac. A child (with a grown-up's help) types or photographs their story book. The app turns it into comic pages to read aloud and print, and into a game with short levels. Everything stays on the device, encrypted. |
| [`mousie-game/`](mousie-game/README.md) | **Mousie: The Adventure Game**, a hand-made, single-file game built from *Mousie, Part 1*, a comic by a 6-year-old. It inspired Wish Circle. |

## Quick start (the app)

```sh
cd app
python3 -m http.server 8000     # then open http://localhost:8000
npm test                        # unit, security-lint and precache tests (Node 20+, no installs)
```

More: [app/README.md](app/README.md) (running, installing, testing, deploying),
[app/SECURITY.md](app/SECURITY.md) (what is protected and how),
[app/PRODUCT.md](app/PRODUCT.md) (vision and roadmap),
[app/CONTRACT.md](app/CONTRACT.md) (the rules all code follows).

## CI and deploy

- `.github/workflows/ci.yml` runs the app's tests on every push and pull request.
- `.github/workflows/pages.yml` deploys `app/` to GitHub Pages on pushes to `main` (or by hand).
  GitHub Pages on a private repository needs a paid GitHub plan. See
  [Deploying](app/README.md#deploying) for Netlify and Cloudflare Pages.
