"""Bundle src/game.html + art/*.jpg into one self-contained Mousie.html."""
import base64, json, pathlib
root = pathlib.Path(__file__).parent
art = {p.stem: "data:image/jpeg;base64," + base64.b64encode(p.read_bytes()).decode() for p in sorted((root / "art").glob("*.jpg"))}
html = (root / "src" / "game.html").read_text()
html = html.replace("__ART_JSON__", json.dumps(art))
for k, v in art.items():
    html = html.replace(f"__ART_{k}__", v)
(root / "Mousie.html").write_text(html)
print(f"Mousie.html: {len(html) / 1e6:.1f} MB")
