"""Bundle src/game.html + src/photo.js + src/scenes/*.js + book art + photo assets into one self-contained HTML file.

Usage: python3 build.py [--out PATH] [--assets DIR]
  --out PATH     where to write the game (default: Mousie.html)
  --assets DIR   folder holding manifest.json + the painted cut-outs and background photos
                 (default: assets/). Without a manifest the game uses its cartoon drawings
                 (PHOTOS = null); a missing or broken file only drops that one picture.
"""
import base64, json, pathlib, re, sys

root = pathlib.Path(__file__).parent


def arg(name, default):
    return pathlib.Path(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


out = arg("--out", root / "Mousie.html")
assets = arg("--assets", root / "assets")
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def load_photos(folder):
    """manifest.json -> ({backgrounds, characters} with each `file` replaced by an index, [data URLs]).
    Identical files (e.g. trex.png and trex-roar.png) are embedded once; photoUnpack() in
    src/photo.js swaps the indexes back to data URLs when the page loads."""
    man_path = folder / "manifest.json"
    if not man_path.is_file():
        print(f"no {man_path}: cartoon drawings only")
        return None, []
    try:
        man = json.loads(man_path.read_text())
    except ValueError as e:
        print(f"bad {man_path} ({e}): cartoon drawings only")
        return None, []
    base = folder.resolve()
    files, index, total = [], {}, 0

    def embed(where, rel):
        nonlocal total
        f = (base / str(rel or "")).resolve()
        if not rel or base not in f.parents or not f.is_file() or f.suffix.lower() not in MIME:
            print(f"  skipped {where}: missing or unsupported file {rel!r}")
            return None
        raw = f.read_bytes()
        if raw not in index:
            index[raw] = len(files)
            files.append(f"data:{MIME[f.suffix.lower()]};base64,{base64.b64encode(raw).decode()}")
            total += len(raw)
        return index[raw]

    photos = {"backgrounds": {}, "characters": {}}
    for group in photos:
        for key, entry in (man.get(group) or {}).items():
            if not isinstance(entry, dict):
                continue
            e = {k: v for k, v in entry.items() if k not in ("file", "poses")}
            if entry.get("file"):
                i = embed(f"{group}/{key}", entry["file"])
                if i is not None:
                    e["file"] = i
            poses = {}
            for pose, pe in (entry.get("poses") or {}).items():
                i = embed(f"{group}/{key}/{pose}", pe.get("file")) if isinstance(pe, dict) else None
                if i is not None:
                    poses[pose] = {**pe, "file": i}
            if poses:
                e["poses"] = poses
            if "file" in e or poses:
                photos[group][key] = e
    n = len(photos["backgrounds"]) + len(photos["characters"])
    print(f"photos: {len(files)} files, {total / 1e6:.2f} MB "
          f"(backgrounds: {', '.join(photos['backgrounds']) or 'none'} | characters: {', '.join(photos['characters']) or 'none'})")
    return (photos, files) if n else (None, [])


def js(value):
    # "</" is escaped so text in a credit can never close the <script> tag
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


html = (root / "src" / "game.html").read_text()
html = html.replace("/*__PHOTO_JS__*/", (root / "src" / "photo.js").read_text())
scenes = "\n".join(p.read_text() for p in sorted((root / "src" / "scenes").glob("*.js")))
html = html.replace("/*__SCENES__*/", scenes)
photos, files = load_photos(assets)
html = html.replace("/*__PHOTOS__*/null", f"photoUnpack({js(photos)}, {js(files)})" if photos else "null")
for key in sorted(set(re.findall(r"__ART_(\w+?)__", html))):
    data = base64.b64encode((root / "art" / f"{key}.jpg").read_bytes()).decode()
    html = html.replace(f"__ART_{key}__", f"data:image/jpeg;base64,{data}")
out.write_text(html)
print(f"{out.name}: {len(html) / 1e6:.2f} MB")
