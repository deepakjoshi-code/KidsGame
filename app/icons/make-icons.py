# Regenerates the Wish Circle icons. Run from app/: python3 -I icons/make-icons.py icons
# Needs Pillow. Not part of the runtime app (not precached).
import math, sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]
CREAM = (251, 244, 226, 255)
INK = (74, 46, 28, 255)
PAPER = (255, 251, 240, 255)
PAPER2 = (246, 236, 212, 255)
RING = (240, 160, 64, 255)
RING_IN = (255, 224, 160, 255)
COVER = (216, 69, 59, 255)
STAR = (255, 205, 60, 255)
S = 4  # supersample

def star_pts(cx, cy, r_out, r_in, n=5, rot=-90):
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = math.radians(rot + i * 180 / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def art(size, scale=1.0, rounded=False):
    """Draw the motif in a size*S canvas. scale shrinks the motif (for maskable safe zone)."""
    W = size * S
    im = Image.new("RGBA", (W, W), CREAM)
    d = ImageDraw.Draw(im)
    u = W / 100 * scale        # motif unit
    o = W * (1 - scale) / 2    # offset to centre
    P = lambda x, y: (o + x * u, o + y * u)
    lw = max(int(3.6 * u), 2)
    # wish circle ring
    cx, cy, r = 50, 46, 38
    d.ellipse([P(cx - r, cy - r), P(cx + r, cy + r)], fill=RING_IN, outline=INK, width=lw)
    r2 = 30
    d.ellipse([P(cx - r2, cy - r2), P(cx + r2, cy + r2)], fill=CREAM, outline=RING, width=int(5 * u))
    # book: cover underneath
    cover = [P(6, 58), P(50, 66), P(94, 58), P(94, 84), P(50, 94), P(6, 84)]
    d.polygon(cover, fill=COVER)
    d.line(cover + [cover[0]], fill=INK, width=lw, joint="curve")
    # left page
    left = [P(17, 50), P(32, 45), P(50, 52), P(50, 85), P(32, 79), P(17, 80)]
    d.polygon(left, fill=PAPER)
    d.line(left + [left[0]], fill=INK, width=lw, joint="curve")
    right = [P(83, 50), P(68, 45), P(50, 52), P(50, 85), P(68, 79), P(83, 80)]
    d.polygon(right, fill=PAPER2)
    d.line(right + [right[0]], fill=INK, width=lw, joint="curve")
    # text lines (only when big enough to read)
    if size >= 120:
        tl = max(int(2.2 * u), 2)
        for k in range(3):
            y = 58 + k * 7
            d.line([P(22, y - 1), P(44, y + 3)], fill=(180, 150, 110, 255), width=tl)
            d.line([P(56, y + 3), P(78, y - 1)], fill=(180, 150, 110, 255), width=tl)
    # star above the book, inside the circle
    sp = star_pts(*P(50, 30), 17 * u, 7.5 * u)
    d.polygon(sp, fill=STAR)
    d.line(sp + [sp[0]], fill=INK, width=lw, joint="curve")
    # sparkles
    if size >= 64:
        for (x, y, rr) in [(80, 18, 6), (20, 22, 4.5)]:
            sp = star_pts(*P(x, y), rr * u, rr * 0.38 * u, n=4, rot=-90)
            d.polygon(sp, fill=STAR)
            d.line(sp + [sp[0]], fill=INK, width=max(int(2.4 * u), 2), joint="curve")
    im = im.resize((size, size), Image.LANCZOS)
    return im

for name, size, scale in [("icon-192.png", 192, 0.92), ("icon-512.png", 512, 0.92),
                          ("icon-maskable-512.png", 512, 0.66), ("icon-180.png", 180, 0.86),
                          ("favicon-32.png", 32, 1.0)]:
    art(size, scale).convert("RGB").save(f"{OUT}/{name}", optimize=True)
    print(name)
