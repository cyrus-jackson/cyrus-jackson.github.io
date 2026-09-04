"""
Strip the baked-in transparency checkerboard from the Kea logo frames.

Two traps, both measured rather than assumed:
  * A plain colour key eats ~51% of the K's upright, because the letterform
    carries near-white highlight bands that match the checker's neutrality.
  * A border-connected flood fill leaves the checkerboard trapped inside the
    orbit ellipse, which is enclosed by the ring and never touches the edge.

So: take every near-neutral/bright pixel as a *candidate*, split candidates
into connected components, and judge each component by texture. A checkerboard
alternates between two greys (std of luminance around 7); a flat artwork
highlight does not (std around 1-3). Components that alternate are background
wherever they sit; flat ones are kept.

Edges were blended against the light checker, so alpha is feathered and the
colour un-premultiplied against the measured grey to remove the white fringe.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = ROOT / "logo/kea-green-k-orbit"
OUT  = ROOT / "assets/logo"
CHROMA_MAX, LUM_MIN = 10, 228
TEXTURE_STD = 4.0      # checker measures ~7, flat artwork ~1-3
MIN_COMPONENT = 150    # smaller specks are left opaque, which is the safe default


def key_frame(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    chroma = a.max(2) - a.min(2)
    lum = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]

    candidate = (chroma <= CHROMA_MAX) & (lum >= LUM_MIN)
    h, w = candidate.shape

    work = Image.fromarray((candidate * 255).astype(np.uint8))
    background = np.zeros((h, w), bool)

    for _ in range(600):
        arr = np.asarray(work)
        hits = np.flatnonzero(arr.ravel() == 255)
        if hits.size == 0:
            break
        y, x = divmod(int(hits[0]), w)
        ImageDraw.floodfill(work, (x, y), 100, thresh=0)
        comp = np.asarray(work) == 100
        if comp.sum() >= MIN_COMPONENT and lum[comp].std() > TEXTURE_STD:
            background |= comp
        work.paste(0, (0, 0, w, h), Image.fromarray((comp * 255).astype(np.uint8)))

    alpha = np.where(background, 0.0, 255.0).astype(np.uint8)
    alpha = np.asarray(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32) / 255.0

    bgv = float(a[background].mean()) if background.any() else 248.0
    rgb = np.clip((a - bgv * (1 - alpha)[..., None]) / np.clip(alpha, 0.15, 1.0)[..., None], 0, 255)
    return Image.fromarray(np.dstack([rgb.astype(np.uint8), (alpha * 255).astype(np.uint8)]), "RGBA")


def build():
    """Key all 24 frames, then emit the sprite strip, stills and wordmark."""
    work = {}
    boxes = []
    for n in range(24):
        im = key_frame(BASE / f"frames/frame-{n:02d}.png")
        work[n] = im
        boxes.append(im.getchannel("A").getbbox())

    # One shared bbox for every frame, or the mark jitters as the orbit swings.
    pad = 12
    x0 = max(0, min(b[0] for b in boxes) - pad)
    y0 = max(0, min(b[1] for b in boxes) - pad)
    x1 = max(b[2] for b in boxes) + pad
    y1 = max(b[3] for b in boxes) + pad
    w, h = x1 - x0, y1 - y0
    side = max(w, h)

    OUT.mkdir(parents=True, exist_ok=True)
    CELL = 96                        # sidebar mark is 36px; ~2.6x for retina
    strip = Image.new("RGBA", (CELL * 24, CELL), (0, 0, 0, 0))
    for n in range(24):
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(work[n].crop((x0, y0, x1, y1)), ((side - w) // 2, (side - h) // 2))
        strip.paste(sq.resize((CELL, CELL), Image.LANCZOS), (CELL * n, 0))
    strip.save(OUT / "k-orbit-sprite.png", optimize=True)

    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(work[0].crop((x0, y0, x1, y1)), ((side - w) // 2, (side - h) // 2))
    for px in (512, 180, 32):
        sq.resize((px, px), Image.LANCZOS).save(OUT / f"k-{px}.png", optimize=True)

    # iOS ignores transparency on touch icons, so give that one the brand ground
    touch = Image.new("RGB", (180, 180), (11, 18, 32))
    k = sq.resize((150, 150), Image.LANCZOS)
    touch.paste(k, (15, 15), k)
    touch.save(OUT / "apple-touch-icon.png", optimize=True)

    wm = Image.open(BASE / "KEA.png").convert("RGBA")       # already has real alpha
    wm = wm.crop(wm.getchannel("A").getbbox())
    for px in (720, 360):
        r = wm.copy(); r.thumbnail((px, px), Image.LANCZOS)
        r.save(OUT / f"kea-wordmark-{px}.png", optimize=True)

    for name in ("k-512.png", "kea-wordmark-720.png", "kea-wordmark-360.png", "k-180.png"):
        f = OUT / name
        im = Image.open(f).convert("RGBA")
        q = im.quantize(colors=192, method=Image.FASTOCTREE, dither=Image.Dither.NONE).convert("RGBA")
        q.putalpha(im.getchannel("A"))
        q.save(f, optimize=True)

    for f in sorted(OUT.iterdir()):
        print(f"  {f.name:26} {f.stat().st_size // 1024:5} KB")


if __name__ == "__main__":
    build()
