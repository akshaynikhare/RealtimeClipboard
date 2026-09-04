#!/usr/bin/env python3
"""
Regenerates the whole app icon set — the PWA icons, the desktop bundle icons and
the SVG favicon — from one table of numbers.

    python tools/build/build-icons.py           # writes every file listed below
    python tools/build/build-icons.py --check   # exit non-zero if any is stale

WHY THIS FILE EXISTS
--------------------
The mark lived in twenty-one committed binaries plus one SVG, and the only way to
change it was the recipe in desktop/README.md: headless Chrome to raster the SVG,
then a transient `npx @tauri-apps/cli icon`. That is a pipeline nobody runs twice.
The PWA set, the desktop set and the favicon were each free to drift, and nothing
could tell that they had.

So the geometry is a table in a 512 grid, and both back ends read it — Pillow for
every raster, a string template for assets/icons/icon.svg. One edit moves all
twenty-two files and --check fails the commit that forgot to run it.

COLOURS
-------
Tints and shades of two tokens in src/styles/tokens.css, --blue #007acc for the
clipboard and --ok #4ec9b0 for the sync ring, and never a new hue. The icon sits
next to the app it launches; a fourth blue invented here would read as a
different product.

THE THREE VARIANTS
------------------
app       the rounded plate, drawn as-is wherever an icon is shown at its own size
maskable  full bleed, glyph inside the 80% safe circle. Android crops this one to
          its own silhouette and what falls outside that circle is not promised
flat      what icon.svg carries — the app variant without the soft shadows, which
          cost bytes in a favicon and turn to grey mud at 16px anyway
"""

import argparse
import io
import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent.parent

# Everything below is in a 512x512 reference grid. SS is how much larger the one
# master render is; every output is a Lanczos reduction of it, so a 32px taskbar
# icon is a resampled 2048 rather than a redraw that could differ.
G = 512
SS = 4
M = G * SS

PLATE_PAD = 4          # the plate is all but full bleed; elevation is inside it
PLATE_N = 5.0          # superellipse exponent — the iOS-style continuous corner

# The glyph, as measured off the source artwork, then scaled about its own centre
# by GLYPH_K. Raising K is how you reduce the white margin.
BODY = (108, 111, 407, 449)
BODY_R = 34
TAB = (177, 60, 335, 150)
TAB_R = 27
HOLE = (256, 93, 21)                       # cx, cy, r
BAR_X, BAR_H = 140, 26
BARS = ((196, 210), (252, 177), (308, 107))   # top, width
RING = (348, 366, 88)                      # cx, cy, mid radius
RING_W = 36
RING_HEAD = 38                             # half-width of an arrowhead
RING_HALO = 10
# Tail and tip of each arm; 0 is 3 o'clock and the sweep is clockwise. The second
# is the first turned by 180, so the pair reads as one ring rather than two arcs.
ARCS = ((178, 332), (358, 152))
ARC_HEAD_DEG = 19

GLYPH_BOX = (108, 60, 468, 468)
GLYPH_K = 1.14
SAFE_K = 0.80          # maskable: the glyph must sit inside the 80% safe circle

PLATE_TOP = (255, 255, 255)
PLATE_BOT = (236, 241, 246)
PLATE_EDGE = (12, 34, 56)
BODY_TOP = (46, 155, 219)      # --blue lightened 18%
BODY_BOT = (0, 95, 159)        # --blue darkened 22%
TAB_TOP = (66, 173, 232)
TAB_BOT = (10, 124, 197)
ARC_A = ((94, 214, 186), (35, 158, 133))   # --ok, lightened and darkened
ARC_B = ((56, 166, 224), (0, 122, 204))    # --blue
INK = (6, 42, 74)              # every shadow; a blue-black, never neutral grey


def squircle(cx, cy, r, steps=720):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + r * math.copysign(abs(c) ** (2 / PLATE_N), c),
                    cy + r * math.copysign(abs(s) ** (2 / PLATE_N), s)))
    return pts


class Frame:
    """Maps the reference grid onto the master canvas, glyph scaling included."""

    def __init__(self, glyph_k):
        self.k = glyph_k * SS
        gx0, gy0, gx1, gy1 = GLYPH_BOX
        self.ox = (G / 2 - (gx0 + gx1) / 2 * glyph_k) * SS
        self.oy = (G / 2 - (gy0 + gy1) / 2 * glyph_k) * SS

    def x(self, v):
        return v * self.k + self.ox

    def y(self, v):
        return v * self.k + self.oy

    def l(self, v):
        return v * self.k

    def box(self, b):
        return [self.x(b[0]), self.y(b[1]), self.x(b[2]), self.y(b[3])]

    def pt(self, cx, cy, r, deg):
        a = math.radians(deg)
        return (self.x(cx) + self.l(r) * math.cos(a),
                self.y(cy) + self.l(r) * math.sin(a))


def mask():
    return Image.new("L", (M, M), 0)


def blank():
    return Image.new("RGBA", (M, M), (0, 0, 0, 0))


def gradient(top, bottom, y0, y1):
    band = Image.new("RGB", (1, M))
    px = band.load()
    for y in range(M):
        t = 0.0 if y1 <= y0 else min(1.0, max(0.0, (y - y0) / (y1 - y0)))
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return band.resize((M, M))


def paint(canvas, shape, top, bottom, span):
    canvas.paste(gradient(top, bottom, *span), (0, 0), shape)


def tint(canvas, shape, colour, alpha):
    canvas.paste(Image.new("RGB", (M, M), colour), (0, 0),
                 shape.point(lambda v: round(v * alpha)))


def shadow(canvas, shape, blur, dy, alpha):
    soft = shape.filter(ImageFilter.GaussianBlur(blur * SS))
    soft = soft.point(lambda v: round(v * alpha))
    layer = mask()
    layer.paste(soft, (0, round(dy * SS)))
    canvas.paste(Image.new("RGB", (M, M), INK), (0, 0), layer)


def arm_mask(f, a0, a1, grow=0.0):
    """One arrow: the arc, a round tail cap, and the head. Each arm is masked on
    its own — a shared mask cut into wedges afterwards paints the cap and the
    head, which overhang their own angles, in the other arm's colour."""
    m = mask()
    d = ImageDraw.Draw(m)
    cx, cy, r = RING
    stroke = RING_W + 2 * grow
    outer = r + stroke / 2
    base = a1 - ARC_HEAD_DEG
    d.arc(f.box((cx - outer, cy - outer, cx + outer, cy + outer)),
          a0, base, fill=255, width=round(f.l(stroke)))
    cap, cr = f.pt(cx, cy, r, a0), f.l(stroke / 2)
    d.ellipse([cap[0] - cr, cap[1] - cr, cap[0] + cr, cap[1] + cr], fill=255)
    d.polygon([f.pt(cx, cy, r, base + ARC_HEAD_DEG + math.degrees(grow / r)),
               f.pt(cx, cy, r + RING_HEAD + grow, base),
               f.pt(cx, cy, r - RING_HEAD - grow, base)], fill=255)
    return m


def rounded(f, box, radius):
    m = mask()
    ImageDraw.Draw(m).rounded_rectangle(f.box(box), radius=f.l(radius), fill=255)
    return m


def render(variant):
    """One master render. `variant` is app, maskable or flat."""
    f = Frame(SAFE_K if variant == "maskable" else GLYPH_K)
    soft = variant != "flat"
    canvas = blank()

    if variant == "maskable":
        plate = Image.new("L", (M, M), 255)
    else:
        plate = mask()
        ImageDraw.Draw(plate).polygon(
            [(x * SS, y * SS) for x, y in
             squircle(G / 2, G / 2, (G - 2 * PLATE_PAD) / 2)], fill=255)
    paint(canvas, plate, PLATE_TOP, PLATE_BOT, (0, M))
    if variant != "maskable":
        edge = ImageChops.subtract(plate, plate.filter(ImageFilter.MinFilter(5)))
        tint(canvas, edge, PLATE_EDGE, 0.10)

    body, tab = rounded(f, BODY, BODY_R), rounded(f, TAB, TAB_R)
    clip = ImageChops.lighter(body, tab)
    if soft:
        shadow(canvas, clip, 7, 9, 0.20)
    paint(canvas, body, BODY_TOP, BODY_BOT, (f.y(BODY[1]), f.y(BODY[3])))
    paint(canvas, tab, TAB_TOP, TAB_BOT, (f.y(TAB[1]), f.y(TAB[3])))

    hx, hy, hr = HOLE
    hole = mask()
    ImageDraw.Draw(hole).ellipse(
        f.box((hx - hr, hy - hr, hx + hr, hy + hr)), fill=255)
    paint(canvas, hole, PLATE_TOP, PLATE_BOT, (0, M))

    if soft:
        rim = ImageChops.subtract(clip, clip.filter(ImageFilter.MinFilter(9)))
        tint(canvas, ImageChops.multiply(rim, gradient(
            (255, 255, 255), (0, 0, 0), f.y(TAB[1]), f.y(BODY[1] + 150)
        ).convert("L")), (255, 255, 255), 0.55)

    bars = mask()
    db = ImageDraw.Draw(bars)
    for top, width in BARS:
        db.rounded_rectangle(f.box((BAR_X, top, BAR_X + width, top + BAR_H)),
                             radius=f.l(BAR_H / 2), fill=255)
    if soft:
        shadow(canvas, bars, 2.5, 3, 0.22)
    tint(canvas, bars, (255, 255, 255), 1.0)

    arms = [arm_mask(f, a0, a1) for a0, a1 in ARCS]
    halo = ImageChops.lighter(*[arm_mask(f, a0, a1, RING_HALO) for a0, a1 in ARCS])
    if soft:
        shadow(canvas, halo, 6, 7, 0.18)
    paint(canvas, halo, PLATE_TOP, PLATE_BOT, (0, M))

    _, cy, r = RING
    span = (f.y(cy - r - RING_W), f.y(cy + r + RING_W))
    for arm, (top, bottom) in zip(arms, (ARC_A, ARC_B)):
        paint(canvas, arm, top, bottom, span)

    if variant == "maskable":
        flat = Image.new("RGB", (M, M), PLATE_TOP)
        flat.paste(canvas, (0, 0), canvas)
        return flat
    return canvas


def resize(master, size):
    return master.resize((size, size), Image.Resampling.LANCZOS)


def svg():
    """The same drawing, emitted as markup. This is the favicon and the mark in
    every page header, so it carries the flat variant — see the module docstring."""
    f = Frame(GLYPH_K)

    def n(v):
        return f"{v / SS:.1f}".rstrip("0").rstrip(".")

    def hexc(c):
        return "#%02x%02x%02x" % c

    def stop(gid, top, bottom, y0, y1):
        return (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
                f'x1="0" y1="{n(y0)}" x2="0" y2="{n(y1)}">'
                f'<stop offset="0" stop-color="{hexc(top)}"/>'
                f'<stop offset="1" stop-color="{hexc(bottom)}"/></linearGradient>')

    def rect(box, radius, fill):
        x0, y0, x1, y1 = f.box(box)
        return (f'<rect x="{n(x0)}" y="{n(y0)}" width="{n(x1 - x0)}" '
                f'height="{n(y1 - y0)}" rx="{n(f.l(radius))}" fill="{fill}"/>')

    cx, cy, r = RING

    def arm(a0, a1, grow, fill):
        stroke = RING_W + 2 * grow
        head = ARC_HEAD_DEG + math.degrees(grow / r)
        p0 = f.pt(cx, cy, r, a0)
        p1 = f.pt(cx, cy, r, a1 - ARC_HEAD_DEG)
        large = 1 if (a1 - ARC_HEAD_DEG - a0) % 360 > 180 else 0
        tip = f.pt(cx, cy, r, a1 + head - ARC_HEAD_DEG)
        b1 = f.pt(cx, cy, r + RING_HEAD + grow, a1 - ARC_HEAD_DEG)
        b2 = f.pt(cx, cy, r - RING_HEAD - grow, a1 - ARC_HEAD_DEG)
        return (f'<path d="M{n(p0[0])} {n(p0[1])}A{n(f.l(r))} {n(f.l(r))} 0 '
                f'{large} 1 {n(p1[0])} {n(p1[1])}" fill="none" stroke="{fill}" '
                f'stroke-width="{n(f.l(stroke))}" stroke-linecap="round"/>'
                f'<path d="M{n(tip[0])} {n(tip[1])}L{n(b1[0])} {n(b1[1])}'
                f'L{n(b2[0])} {n(b2[1])}Z" fill="{fill}"/>')

    plate = "".join(
        f'{"M" if i == 0 else "L"}{x:.1f} {y:.1f}'
        for i, (x, y) in enumerate(squircle(
            G / 2, G / 2, (G - 2 * PLATE_PAD) / 2, steps=192))) + "Z"
    hx, hy, hr = HOLE

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512" role="img" aria-label="RealtimeClipboard">',
        "<title>RealtimeClipboard</title>",
        "<!-- GENERATED by tools/build/build-icons.py — do not hand-edit. -->",
        "<defs>",
        stop("p", PLATE_TOP, PLATE_BOT, 0, M),
        stop("b", BODY_TOP, BODY_BOT, f.y(BODY[1]), f.y(BODY[3])),
        stop("t", TAB_TOP, TAB_BOT, f.y(TAB[1]), f.y(TAB[3])),
        stop("a", *ARC_A, f.y(cy - r - RING_W), f.y(cy + r + RING_W)),
        stop("c", *ARC_B, f.y(cy - r - RING_W), f.y(cy + r + RING_W)),
        "</defs>",
        f'<path d="{plate}" fill="url(#p)"/>',
        rect(BODY, BODY_R, "url(#b)"),
        rect(TAB, TAB_R, "url(#t)"),
        f'<circle cx="{n(f.x(hx))}" cy="{n(f.y(hy))}" r="{n(f.l(hr))}" '
        'fill="url(#p)"/>',
    ]
    parts += [rect((BAR_X, top, BAR_X + width, top + BAR_H), BAR_H / 2, "#fff")
              for top, width in BARS]
    parts += [arm(a0, a1, RING_HALO, "url(#p)") for a0, a1 in ARCS]
    parts += [arm(a0, a1, 0, fill)
              for (a0, a1), fill in zip(ARCS, ("url(#a)", "url(#c)"))]
    parts.append("</svg>")
    return ("\n".join(parts) + "\n").encode("utf-8")


DESKTOP = {
    "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256,
    "icon.png": 512, "StoreLogo.png": 50,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def png(image, size, mode="RGBA"):
    buf = io.BytesIO()
    resize(image, size).convert(mode).save(buf, "PNG", optimize=True)
    return buf.getvalue()


def build():
    """Every output file as path -> bytes, so --check is a plain comparison."""
    app = render("app")
    maskable = render("maskable")
    out = {ROOT / "assets/icons/icon.svg": svg()}

    for size in (192, 512):
        out[ROOT / f"assets/icons/icon-{size}.png"] = png(app, size)
        out[ROOT / f"assets/icons/maskable-{size}.png"] = png(maskable, size, "RGB")

    # The Marketplace listing icon. One more consumer of the same master render,
    # so the extension's mark cannot drift from the app's.
    out[ROOT / "vscode/icon.png"] = png(app, 128)

    icons = ROOT / "desktop/src-tauri/icons"
    for name, size in DESKTOP.items():
        out[icons / name] = png(app, size)

    buf = io.BytesIO()
    resize(app, 256).save(buf, "ICO", sizes=[(s, s) for s in ICO_SIZES],
                          append_images=[resize(app, s) for s in ICO_SIZES])
    out[icons / "icon.ico"] = buf.getvalue()

    buf = io.BytesIO()
    resize(app, 1024).save(buf, "ICNS", sizes=[(s, s) for s in ICNS_SIZES])
    out[icons / "icon.icns"] = buf.getvalue()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if any icon is out of date")
    args = ap.parse_args()

    files = build()
    if args.check:
        stale = [p for p, data in files.items()
                 if not p.exists() or p.read_bytes() != data]
        if stale:
            for p in stale:
                print(f"{p.relative_to(ROOT).as_posix()} is out of date")
            print("run: npm run build:icons")
            return 1
        print(f"{len(files)} icons are up to date")
        return 0

    for p, data in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    print(f"wrote {len(files)} icons "
          f"({len(files) - 1} rasters + assets/icons/icon.svg)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
