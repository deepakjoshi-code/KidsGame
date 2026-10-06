#!/usr/bin/env python3
"""Build a Wish Circle book pack (.wishbook) from the Mousie comic, so the family can import it.

The pack holds a child's artwork. Write it OUTSIDE the repository (the default is a scratch path)
and never commit it.

    python3 -I app/tools/make_book_pack.py [--out FILE] [--art DIR] [--chars DIR] [--no-sprites]
                                           [--title T] [--author A]

Needs Python 3 and Pillow. Pages are re-encoded as JPEG (max 1400px), character cut-outs as
PNG sprites (max 512px), matching what the app itself stores.
"""
import argparse
import base64
import io
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_ART = os.path.join(REPO, "mousie-game", "art")
DEFAULT_CHARS = os.path.join(REPO, "mousie-game", "assets", "chars")
DEFAULT_OUT = "/tmp/claude-0/-home-user-wish-circle/b9ac1d4a-b524-5cd9-8270-6501b1ec2bef/scratchpad/mousie.wishbook"

MAX_PAGE = 1400
MAX_SPRITE = 512

# Cast: pack id, name, emoji, catalog kind, faces, role, big, words, cut-out file, cut-out facing.
CAST = [
    ("mousie", "Mousie", "🐁", "mouse", "left", "hero", False, ["mousie", "mousey", "mouse"], "mousie.png", "right"),
    ("daddy", "Daddy", "🐭", "dad", "front", "friend", False, ["daddy", "dad"], "daddy.png", "left"),
    ("birdie", "Birdie", "🐦", "bird", "left", "friend", False, ["birdie", "birdy", "bird"], "birdie.png", "right"),
    ("raptor", "Velociraptor", "🦖", "raptor", "left", "villain", False, ["velociraptor", "raptor"], None, None),
    ("trex", "T-Rex", "🦖", "trex", "left", "villain", True, ["t-rex", "trex", "tyrannosaurus"], "trex-roar.png", "right"),
    ("snake", "Snake", "🐍", "snake", "left", "friend", False, ["snake"], "snake.png", "left"),
    ("lion", "Lion", "🦁", "lion", "front", "friend", False, ["lion"], "lion.png", "left"),
    ("truck", "Fire truck", "🚒", "firetruck", "left", "friend", False, ["fire truck", "firetruck"], "firetruck.png", "right"),
]

# Story order, from the original game's STEPS (mousie-game/src/game.html, first commit).
# (art file, place, action, narration, [(speaker, text)], [actors])
PAGES = [
    ("daddy1", "forest", "none", "", [("mousie", "Hi Daddy. Can I go on an adventure with Birdie?")], ["mousie", "daddy"]),
    ("daddy2", "forest", "none", "", [("daddy", "Ok.")], ["mousie", "daddy"]),
    ("hibirdie", "forest", "none", "", [("birdie", "Hi Mousie!")], ["mousie", "birdie"]),
    ("adventure", "forest", "journey", "", [("mousie", "We're going on an adventure!")], ["mousie", "birdie"]),
    ("cave", "cave", "none", "", [("mousie", "Look! A cave!"), ("birdie", "Let's go inside!")], ["mousie", "birdie"]),
    ("inside", "cave", "none", "Mousie and Birdie tiptoe into the dark cave.", [], ["mousie", "birdie"]),
    ("raptor", "cave", "none", "", [("birdie", "Look, a Velociraptor!"), ("mousie", "Oh no! What do we do?")], ["mousie", "birdie", "raptor"]),
    ("fight", "cave", "battle", "", [("birdie", "I think we should fight it."), ("mousie", "Ok.")], ["mousie", "birdie", "raptor"]),
    ("arrows", "cave", "none", "", [("birdie", "Good, I took the arrows and fight!")], ["birdie", "raptor"]),
    ("trexcame", "cave", "none", "", [("birdie", "Hooray, Velociraptor died!"), ("trex", "ROOR!"), ("mousie", "Are you sure hooray? T-Rex came!")], ["mousie", "birdie", "trex"]),
    ("trex", "cave", "none", "", [("trex", "ROOR!"), ("mousie", "Let's fight it!")], ["mousie", "trex"]),
    ("bombarrows", "cave", "none", "", [("birdie", "Ok, let's fight it with bombs and arrows!")], ["mousie", "birdie", "trex"]),
    ("bigbomb", "cave", "battle", "", [("mousie", "Look how big the bomb is! Let's do it!")], ["mousie", "birdie", "trex"]),
    ("boom", "cave", "none", "BOOM!", [("mousie", "We won the day!")], ["mousie", "birdie", "trex"]),
    ("snake1", "forest", "none", "", [("mousie", "Hi Snake!! Why are you here??")], ["mousie", "snake"]),
    ("snake2", "forest", "none", "", [("snake", "Your daddy sent me to see if you need any help.")], ["mousie", "snake"]),
    ("lion1", "forest", "none", "", [("snake", "Guys!! Look at my pet lion!")], ["snake", "lion"]),
    ("lion2", "forest", "friends", "", [("lion", "ZOOOOM!")], ["snake", "lion"]),
    ("truck1", "forest", "none", "", [("snake", "Guys!! Look at my fire truck!!")], ["snake", "truck"]),
    ("truck2", "forest", "friends", "", [("truck", "NEEE-NAW, NEEE-NAW!")], ["snake", "truck"]),
    ("yah", "forest", "celebrate", "Everyone: YAH!", [("mousie", "OK!!"), ("birdie", "Let's go home!!"), ("snake", "Hehe")], ["mousie", "birdie", "snake", "lion", "truck"]),
    ("treehouse", "home", "climb", "", [("mousie", "It's perfect! Safe and wonderful."), ("birdie", "Hooray! We made it!")], ["mousie", "birdie"]),
]


def fit(w, h, m):
    s = min(1.0, m / max(w, h))
    return max(1, round(w * s)), max(1, round(h * s))


def data_url(img, fmt):
    buf = io.BytesIO()
    if fmt == "JPEG":
        img.convert("RGB").save(buf, "JPEG", quality=85, optimize=True)
        mime = "image/jpeg"
    else:
        img.save(buf, "PNG", optimize=True)
        mime = "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(buf.getvalue()).decode("ascii"))


def page_image(path):
    with Image.open(path) as im:
        im = im.convert("RGB")
        return im.resize(fit(im.width, im.height, MAX_PAGE), Image.LANCZOS) if max(im.size) > MAX_PAGE else im.copy()


def sprite_image(path):
    with Image.open(path) as im:
        im = im.convert("RGBA")
        box = im.getchannel("A").getbbox()
        if box:
            im = im.crop(box)
        return im.resize(fit(im.width, im.height, MAX_SPRITE), Image.LANCZOS)


def build(art_dir, chars_dir, sprites, title, author):
    images = {}
    n = 0

    def add(url):
        nonlocal n
        n += 1
        key = "i%d" % n
        images[key] = url
        return key

    cast = []
    for cid, name, emoji, kind, faces, role, big, words, cut, facing in CAST:
        image_id = None
        flip = False
        if sprites and cut and os.path.exists(os.path.join(chars_dir, cut)):
            image_id = add(data_url(sprite_image(os.path.join(chars_dir, cut)), "PNG"))
            flip = facing == "left"  # the app assumes drawings face right; flip mirrors them
        cast.append({"id": cid, "name": name, "emoji": emoji, "kind": kind, "faces": faces, "flip": flip,
                     "imageId": image_id, "role": role, "big": big, "words": words})

    cover = None
    cover_path = os.path.join(art_dir, "cover.jpg")
    if os.path.exists(cover_path):
        cover = add(data_url(page_image(cover_path), "JPEG"))

    pages = []
    for i, (art, place, action, narration, lines, actors) in enumerate(PAGES):
        path = os.path.join(art_dir, art + ".jpg")
        if not os.path.exists(path):
            sys.exit("missing panel: %s" % path)
        pages.append({
            "id": "p%d" % (i + 1),
            "imageId": add(data_url(page_image(path), "JPEG")),
            "place": place,
            "narration": narration,
            "lines": [{"who": w, "text": t} for w, t in lines],
            "actors": actors,
            "action": action,
        })

    return {"format": "wishcircle-book", "v": 1, "title": title, "author": author,
            "cover": cover, "cast": cast, "pages": pages, "images": images}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--art", default=DEFAULT_ART)
    ap.add_argument("--chars", default=DEFAULT_CHARS)
    ap.add_argument("--no-sprites", action="store_true", help="use emoji instead of the cut-out drawings")
    ap.add_argument("--title", default="Mousie, Part 1")
    ap.add_argument("--author", default="Samar")
    a = ap.parse_args()

    out = os.path.abspath(a.out)
    if out == REPO or out.startswith(REPO + os.sep):
        sys.exit("refusing to write a child's artwork inside the repository: " + out)
    pack = build(a.art, a.chars, not a.no_sprites, a.title, a.author)
    text = json.dumps(pack, ensure_ascii=False, separators=(",", ":"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %s (%d pages, %d characters, %d pictures, %.1f MB)" % (
        out, len(pack["pages"]), len(pack["cast"]), len(pack["images"]), len(text.encode("utf-8")) / 1e6))


if __name__ == "__main__":
    main()
