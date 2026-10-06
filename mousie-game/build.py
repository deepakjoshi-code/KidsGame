"""Bundle src/game.html + src/scenes/*.js + used art into one self-contained HTML file.

Usage: python3 build.py [--out PATH]   (default: Mousie.html)
"""
import base64, pathlib, re, sys
root = pathlib.Path(__file__).parent
out = pathlib.Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else root / "Mousie.html"
html = (root / "src" / "game.html").read_text()
scenes = "\n".join(p.read_text() for p in sorted((root / "src" / "scenes").glob("*.js")))
html = html.replace("/*__SCENES__*/", scenes)
for key in sorted(set(re.findall(r"__ART_(\w+?)__", html))):
    data = base64.b64encode((root / "art" / f"{key}.jpg").read_bytes()).decode()
    html = html.replace(f"__ART_{key}__", f"data:image/jpeg;base64,{data}")
out.write_text(html)
print(f"{out.name}: {len(html) / 1e6:.2f} MB")
