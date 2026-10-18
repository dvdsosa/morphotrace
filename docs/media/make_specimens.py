# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow"]
# ///
"""Synthetic plankton images for the README media (no third-party image licences involved).

Bright-field look similar to in-situ plankton imagers: light grey background with a slight gradient,
vignetting and sensor noise; organisms are semi-transparent, with darker rims (refraction), low-frequency
internal texture and translucent appendages. Deterministic (seeded).

    uv run docs/media/make_specimens.py      # writes docs/media/specimens/<Class>/<name>.png
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).parent / "specimens"
SS = 3  # supersampling factor for drawing


class Canvas:
    """Masks drawn at SS× and returned as float arrays (0..1) at image size."""

    def __init__(self, w, h):
        self.w, self.h = w, h

    def layer(self):
        im = Image.new("L", (self.w * SS, self.h * SS), 0)
        return im, ImageDraw.Draw(im)

    def arr(self, im, blur=0.0):
        a = im.resize((self.w, self.h), Image.LANCZOS)
        if blur:
            a = a.filter(ImageFilter.GaussianBlur(blur))
        return np.asarray(a, float) / 255


def S(pts):
    return [(x * SS, y * SS) for x, y in pts]


def background(w, h, level=206):
    y, x = np.mgrid[0:h, 0:w]
    g = level + 6 * (x / w - 0.5) - 4 * (y / h - 0.5)
    return g - 16 * np.hypot(x / w - 0.5, y / h - 0.5) ** 2


def lowfreq(rng, w, h, cell=18):
    small = rng.normal(0, 1, (h // cell + 2, w // cell + 2))
    im = Image.fromarray(((small - small.min()) / (np.ptp(small) + 1e-9) * 255).astype(np.uint8))
    return np.asarray(im.resize((w, h), Image.BICUBIC), float) / 255


def rim(mask, width=2.5):
    """Darker boundary band of a soft mask (refraction at the organism's edge)."""
    m = Image.fromarray((mask * 255).astype(np.uint8))
    inner = np.asarray(m.filter(ImageFilter.GaussianBlur(width)), float) / 255
    return np.clip(mask - np.clip((inner - 0.5) * 2.2, 0, 1), 0, 1)


def compose(base, dark, rng, noise=2.4):
    img = base * (1 - np.clip(dark, 0, 0.9)) + rng.normal(0, noise, base.shape)
    img = np.clip(img, 0, 255)
    rgb = np.stack([img, img * 1.008, img * 1.02], -1).clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def rot(pts, ang, cx, cy):
    c, s = math.cos(ang), math.sin(ang)
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in pts]


def bezier(p0, p1, bend, n=60):
    (x0, y0), (x1, y1) = p0, p1
    nx, ny = -(y1 - y0), x1 - x0
    L = math.hypot(nx, ny) or 1
    cx, cy = (x0 + x1) / 2 + bend * nx / L, (y0 + y1) / 2 + bend * ny / L
    return [((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1)
            for t in np.linspace(0, 1, n)]


def tapered(draw, pts, w0, w1, fill=255):
    for i in range(len(pts) - 1):
        wdt = w0 + (w1 - w0) * i / (len(pts) - 1)
        draw.line(S([pts[i], pts[i + 1]]), fill=fill, width=max(1, round(wdt * SS)))
        r = wdt / 2
        x, y = pts[i]
        draw.ellipse(S([(x - r, y - r), (x + r, y + r)]), fill=fill)


def copepod(rng, w=560, h=420):
    C = Canvas(w, h)
    cx, cy, ang = 300, 222, math.radians(-18)
    body_im, bd = C.layer()
    # prosome: egg-shaped (blunter head), then tapering urosome segments and the furca
    prosome = []
    for t in np.linspace(0, 2 * math.pi, 120):
        a = 112 * (1 + 0.04 * math.cos(t))
        b = 44 * (1 - 0.18 * math.cos(t))
        prosome.append((cx + a * math.cos(t), cy + b * math.sin(t)))
    bd.polygon(S(rot(prosome, ang, cx, cy)), fill=255)
    ux, uy = rot([(cx + 104, cy + 2)], ang, cx, cy)[0]
    ua = ang + math.radians(12)
    pts = [(ux + k * 2.4 * math.cos(ua) + 2.5 * math.sin(k / 6), uy + k * 2.4 * math.sin(ua)) for k in range(41)]
    tapered(bd, pts, 30, 15)
    furca = pts[-1]
    body = C.arr(body_im, 0.6)

    app_im, ad = C.layer()
    # antennules from the front of the head, long and tapering, with setae
    hx, hy = rot([(cx - 108, cy - 6)], ang, cx, cy)[0]
    for side, end, bend in ((-1, (238, 20), -70), (1, (96, 400), 60)):
        a_pts = bezier((hx + 4, hy + side * 10), end, bend, 100)
        tapered(ad, a_pts, 6.0, 1.6)
        for i in range(12, len(a_pts) - 4, 8):
            (x0, y0), (x1, y1) = a_pts[i], a_pts[i + 1]
            nx, ny = -(y1 - y0), x1 - x0
            L = math.hypot(nx, ny) or 1
            ad.line(S([(x0, y0), (x0 - 10 * nx / L * side, y0 - 10 * ny / L * side)]), fill=170, width=SS)
    for da in (-0.3, -0.1, 0.1, 0.3):  # caudal setae
        a = ua + da
        ad.line(S(bezier(furca, (furca[0] + 78 * math.cos(a), furca[1] + 78 * math.sin(a)), 8 * np.sign(da), 30)), fill=200, width=round(1.5 * SS))
    for k in range(5):  # swimming legs
        lx, ly = rot([(cx - 52 + 24 * k, cy + 30)], ang, cx, cy)[0]
        tapered(ad, bezier((lx, ly), (lx + 6, ly + 30), 4, 12), 4.5, 1.5, fill=210)
    app = C.arr(app_im, 0.7)

    seg_im, sd = C.layer()  # segment boundaries, clipped to the body below
    for sx in (-44, -10, 22, 50, 74):
        sd.line(S(rot(bezier((cx + sx, cy - 60), (cx + sx + 4, cy + 60), 8, 20), ang, cx, cy)), fill=255, width=round(2.2 * SS))
    segs = C.arr(seg_im, 0.8) * body

    gut_im, gd = C.layer()  # gut along the axis, lipid droplets
    tapered(gd, rot(bezier((cx - 70, cy + 2), (cx + 150, cy + 14), 6, 40), ang, cx, cy), 15, 6)
    gut = C.arr(gut_im, 2.5) * body
    drops = np.zeros((h, w))
    yy, xx = np.mgrid[0:h, 0:w]
    for _ in range(9):
        gx, gy = rot([(cx + rng.uniform(-80, 50), cy + rng.uniform(-18, 18))], ang, cx, cy)[0]
        r = rng.uniform(3.5, 7)
        drops = np.maximum(drops, np.clip(1 - np.hypot(xx - gx, yy - gy) / r, 0, 1))
    tex = lowfreq(rng, w, h, 14)
    eye = np.clip(1 - np.hypot(xx - rot([(cx - 96, cy - 2)], ang, cx, cy)[0][0], yy - rot([(cx - 96, cy - 2)], ang, cx, cy)[0][1]) / 5.5, 0, 1)

    dark = body * (0.30 + 0.16 * tex) + 0.34 * rim(body, 3) + 0.16 * segs + 0.22 * gut - 0.14 * drops * body
    dark = np.maximum(dark, app * 0.42) + 0.55 * eye

    # outlines an annotator would draw (image px), for docs/media/record.e2e.js:
    # body = clicks around prosome + urosome (2 px outside the edge); antenna = freehand loop around the
    # lower antennule, starting inside the head so that it merges with the body
    out = lambda pts: [[round(x, 1), round(y, 1)] for x, y in pts]
    pro = lambda t, m=2.5: (cx + (112 * (1 + 0.04 * math.cos(t)) + m) * math.cos(t), cy + (44 * (1 - 0.18 * math.cos(t)) + m) * math.sin(t))
    body_click = rot([pro(t) for t in np.linspace(0.42, 2 * math.pi - 0.42, 13)], ang, cx, cy)
    n_up = (math.sin(ua), -math.cos(ua))
    uro = [(pts[k], 15 - 7.5 * k / 40 + 2.5) for k in (16, 40)]
    top = [(x + n_up[0] * r, y + n_up[1] * r) for (x, y), r in uro]
    bot = [(x - n_up[0] * r, y - n_up[1] * r) for (x, y), r in uro]
    tip = (furca[0] + 9 * math.cos(ua), furca[1] + 9 * math.sin(ua))
    body_click = body_click + top + [tip] + bot[::-1]
    a_pts = bezier((hx + 4, hy + 10), (96, 400), 60, 100)
    side_a, side_b = [], []
    for i in range(0, len(a_pts) - 1, 3):
        (x0, y0), (x1, y1) = a_pts[i], a_pts[i + 1]
        nx, ny = -(y1 - y0), x1 - x0
        L = math.hypot(nx, ny) or 1
        r = (6.0 - 4.4 * i / len(a_pts)) / 2 + 2.2
        side_a.append((x0 + r * nx / L, y0 + r * ny / L)); side_b.append((x0 - r * nx / L, y0 - r * ny / L))
    start = rot([(cx - 92, cy + 6)], ang, cx, cy)[0]
    antenna = [start] + side_a + [a_pts[-1]] + side_b[::-1] + [start]
    vertex = body_click[6]  # head vertex dragged in the Edit step
    paths = {"body": out(body_click), "antenna": out(antenna), "edit_vertex": out([vertex])[0]}
    return compose(background(w, h), dark, rng), paths


def arrow_worm(rng, w=600, h=300):
    C = Canvas(w, h)
    spine = bezier((70, 168), (540, 118), 26, 140)
    b_im, bd = C.layer()
    for i, (x, y) in enumerate(spine):
        t = i / (len(spine) - 1)
        r = 7 + 8 * math.sin(math.pi * min(1, t * 1.15)) - 5 * t
        bd.ellipse(S([(x - r, y - r), (x + r, y + r)]), fill=255)
    body = C.arr(b_im, 0.6)
    f_im, fd = C.layer()
    for (i0, i1, s) in ((70, 98, 1), (70, 98, -1), (108, 132, 1), (108, 132, -1)):
        mid = spine[(i0 + i1) // 2]
        fd.polygon(S([spine[i0], (mid[0], mid[1] + s * 24), spine[i1]]), fill=255)
    fins = C.arr(f_im, 0.8) * (1 - body)
    a_im, ad = C.layer()
    hx, hy = spine[0]
    for a in np.linspace(-0.9, 0.9, 7):  # grasping spines
        tapered(ad, bezier((hx, hy), (hx - 24 * math.cos(a), hy + 24 * math.sin(a)), 6 * a, 12), 2.6, 1.0)
    tapered(ad, spine[18:115], 4.5, 3.0)  # gut
    gut, spines = C.arr(a_im, 0.8) * body, C.arr(a_im, 0.8) * (1 - body)
    tex = lowfreq(rng, w, h, 16)
    dark = body * (0.12 + 0.08 * tex) + 0.30 * rim(body, 2.2) + 0.20 * gut + 0.10 * fins + 0.18 * rim(fins, 1.5) + 0.40 * spines
    return compose(background(w, h, 210), dark, rng)


def fish_egg(rng, w=360, h=360):
    C = Canvas(w, h)
    c = (180, 182)
    e_im, ed = C.layer()
    ed.ellipse(S([(c[0] - 122, c[1] - 120), (c[0] + 122, c[1] + 120)]), fill=255)
    egg = C.arr(e_im, 0.6)
    m_im, md = C.layer()
    tapered(md, bezier((104, 232), (252, 116), -72, 90), 34, 12)  # curled embryo
    embryo = C.arr(m_im, 1.0) * egg
    yy, xx = np.mgrid[0:h, 0:w]
    oil = np.clip(1 - np.hypot(xx - (c[0] + 34), yy - (c[1] + 38)) / 24, 0, 1) ** 0.6
    tex = lowfreq(rng, w, h, 20)
    dark = egg * 0.06 + 0.36 * rim(egg, 2.0) + embryo * (0.30 + 0.12 * tex) + 0.16 * rim(embryo, 2) + 0.26 * oil
    return compose(background(w, h, 208), dark, rng)


if __name__ == "__main__":
    rng = np.random.default_rng(2026)
    # class folders sort in this order (the tool lists images alphabetically): the copepod opens first
    for cls, name, fn in (("Copepoda", "copepod_01.png", copepod), ("Sagittoidea", "arrow_worm_01.png", arrow_worm),
                          ("Pisces", "fish_egg_01.png", fish_egg)):
        p = OUT / cls / name
        p.parent.mkdir(parents=True, exist_ok=True)
        res = fn(rng)
        img, paths = res if isinstance(res, tuple) else (res, None)
        img.save(p, optimize=True)
        if paths:
            (OUT / (p.stem + ".paths.json")).write_text(json.dumps(paths))
        print(p)
