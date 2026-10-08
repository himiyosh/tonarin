"""Derives the raster icons that are not drawn for macOS from the app icon:

- build/icon.ico      the Windows app, its installer and shortcuts
- assets/tray.ico     the Windows notification-area icon
- site/favicon.png    the download site's tab icon
- site/og.png         the download site's link preview (1200 x 630)

  python3 scripts/derive-icons.py      (needs Pillow: python3 -m pip install pillow)

assets/icon.png is drawn for macOS: an 824 px squircle with a soft shadow on a 1024 canvas (Big Sur grid). Windows
icons fill their square, so the squircle is cut out along its own outline (the clip path "asq" in assets/icon.svg),
without the shadow, and scaled to the sizes Windows asks for at each display scale. The files are kept in the repo,
so builds do not need Python.
"""
import pathlib
import re

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOX = (100, 100, 924, 924)  # the squircle on the 1024 canvas
APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]
SUPERSAMPLE = 4
# The icon's own colors (assets/icon.svg): background gradient and the three glows inside the squircle.
GRADIENT = [(0.0, (0x4F, 0x46, 0xFF)), (0.5, (0x8B, 0x5C, 0xF6)), (1.0, (0xFF, 0x6F, 0xB5))]
GLOWS = [((0.84, 0.16), (0.26, 0.30), (0x6F, 0xF2, 0xD2), 0.34), ((0.18, 0.90), (0.36, 0.26), (0xFF, 0xB3, 0x6B), 0.36),
         ((0.10, 0.12), (0.30, 0.30), (0x3B, 0x82, 0xF6), 0.42)]
ROUNDED_FONT = "/System/Library/Fonts/SFNSRounded.ttf"


def squircle_mask(size):
    svg = (ROOT / "assets" / "icon.svg").read_text()
    outline = re.search(r'<clipPath id="asq"><path d="([^"]+)"', svg).group(1)
    points = [(float(x) * SUPERSAMPLE, float(y) * SUPERSAMPLE) for x, y in re.findall(r"(-?[\d.]+),(-?[\d.]+)", outline)]
    mask = Image.new("L", (size * SUPERSAMPLE, size * SUPERSAMPLE), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def full_bleed():
    icon = Image.open(ROOT / "assets" / "icon.png").convert("RGBA")
    red, green, blue, alpha = icon.split()
    alpha = ImageChops.multiply(alpha, squircle_mask(icon.width))  # keeps the soft edge, drops the shadow around it
    return Image.merge("RGBA", (red, green, blue, alpha)).crop(BOX)


def write_ico(image, sizes, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    frames = [image.resize((size, size), Image.LANCZOS) for size in sizes]
    frames[-1].save(target, format="ICO", sizes=[(size, size) for size in sizes], append_images=frames[:-1])
    report(target)


def report(target):
    print(f"wrote {target.relative_to(ROOT)} ({target.stat().st_size // 1024} KB)")


def brand_field(width, height):
    """The icon's background at any size: a diagonal gradient with its three soft glows."""
    field = Image.new("RGB", (width, height))
    pixels = field.load()
    for y in range(height):
        for x in range(width):
            t = min(1.0, max(0.0, (0.8 * x / width + 0.2 + y / height) / 2.0 - 0.05))
            for (t0, c0), (t1, c1) in zip(GRADIENT, GRADIENT[1:]):
                if t <= t1:
                    k = (t - t0) / (t1 - t0)
                    pixels[x, y] = tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
                    break
    for (cx, cy), (rx, ry), color, opacity in GLOWS:
        glow = Image.new("L", (width, height), 0)
        box = (int((cx - rx) * width), int((cy - ry) * height), int((cx + rx) * width), int((cy + ry) * height))
        ImageDraw.Draw(glow).ellipse(box, fill=int(255 * opacity))
        glow = glow.filter(ImageFilter.GaussianBlur(min(width, height) * 0.12))
        field = Image.composite(Image.new("RGB", (width, height), color), field, glow)
    return field


def social_card(image, target):
    width, height = 1200, 630
    card = brand_field(width, height).convert("RGBA")
    icon = image.resize((360, 360), Image.LANCZOS)
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 0))
    shadow.paste((32, 20, 90, 110), (100, 150, 460, 510), icon.split()[3])
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(24)))
    card.alpha_composite(icon, (96, 128))
    draw = ImageDraw.Draw(card)
    def font(size, weight):
        face = ImageFont.truetype(ROUNDED_FONT, size)
        axes = {axis["name"]: axis["default"] for axis in face.get_variation_axes()}
        axes[b"Weight"] = weight
        face.set_variation_by_axes(list(axes.values()))
        return face

    draw.text((520, 168), "Tonarin", font=font(132, 700), fill="white")
    draw.text((526, 334), "The one next to you.", font=font(54, 600), fill="white")
    draw.text((528, 420), "Apple Silicon Macs · Windows 10/11 (preview)", font=font(30, 500), fill="white")
    card.convert("RGB").save(target, optimize=True)
    report(target)


def main():
    image = full_bleed()
    write_ico(image, APP_SIZES, ROOT / "build" / "icon.ico")
    write_ico(image, TRAY_SIZES, ROOT / "assets" / "tray.ico")
    image.resize((64, 64), Image.LANCZOS).save(ROOT / "site" / "favicon.png", optimize=True)
    report(ROOT / "site" / "favicon.png")
    social_card(image, ROOT / "site" / "og.png")


if __name__ == "__main__":
    main()
