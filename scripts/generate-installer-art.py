"""
Generates the two bitmaps the Windows installer shows.

WHY THESE EXIST. The NSIS installer Tauri builds is the stock Modern UI wizard,
and left alone it wears NSIS's own 1990s artwork: a gray gradient sidebar and an
empty white header. Nothing about it says which app you are installing.

  sidebar.bmp  164x314, the Welcome and Finish pages. Full-bleed brand art.
               This is the one the eye actually lands on.

  header.bmp   150x57, the strip across the top of every other page. It sits at
               the RIGHT end of that strip (MUI_HEADERIMAGE_RIGHT in the
               template), with the page title in the empty space to its left, so
               unlike the usual arrangement this one can be dark edge to edge:
               nothing is ever written over it.

WHERE THE COLORS COME FROM. The icon itself, not a palette typed out from
memory. The washes behind both bitmaps are the icon blurred past recognition
and darkened, so what shows through is the real nebula: magenta on the left,
blue on the right, near-black between them. Constants below are sampled from
the same file. Change the icon and rerun this; the artwork follows.

WHY BMP. NSIS reads BMP and nothing else for these two slots. 24-bit, no alpha:
MUI composites them itself and an alpha channel is either ignored or renders as
black depending on the build.

WHY A SCRIPT rather than two files somebody made once in an image editor. The
output IS committed, the same way src-tauri/icons is, because a release build
must not need Python. The script is committed so the artwork can be rebuilt
from the app's own colors instead of redrawn from memory.

    python scripts/generate-installer-art.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "src-tauri" / "installer"

# Sampled off the icon: the two accents it is lit by, and the near-black it sits
# on. See the module docstring. INK is the icon's own darkest ground, which is
# blue-black rather than neutral.
INK = (10, 7, 20)
MAGENTA = (250, 43, 214)
BLUE = (46, 140, 255)
TEXT = (242, 237, 255)
TEXT_DIM = (169, 156, 196)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_SEMI = "C:/Windows/Fonts/seguisb.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    """A real font, or PIL's bitmap default if Windows is not underfoot."""
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def lerp(a, b, t: float):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def nebula(size, crop: float, darken: float) -> Image.Image:
    """The icon, blurred past recognition and darkened, filling `size`.

    Using the icon itself rather than hand-mixed gradients is the whole point:
    the light lands where the icon's light lands, and it keeps doing so when the
    icon changes. `crop` trims the rounded-square border off first, because that
    border is a bright ring and scaled up it reads as a stripe rather than as
    light.
    """
    src = Image.open(ICON).convert("RGB")
    w, h = src.size
    inset = round(w * crop)
    src = src.crop((inset, inset, w - inset, h - inset))

    # Cover, not fit: fill the target and lose the overflow, so there is never
    # a bar of dead color down one side.
    tw, th = size
    scale = max(tw / src.width, th / src.height)
    src = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
    left = (src.width - tw) // 2
    top = (src.height - th) // 2
    src = src.crop((left, top, left + tw, top + th))

    src = src.filter(ImageFilter.GaussianBlur(max(tw, th) / 7))
    src = ImageEnhance.Color(src).enhance(1.6)
    return Image.blend(src, Image.new("RGB", size, INK), darken)


def accent_rule(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int) -> None:
    """A magenta-to-blue rule, drawn along whichever axis is longer."""
    horizontal = (x1 - x0) >= (y1 - y0)
    span = (x1 - x0) if horizontal else (y1 - y0)
    for i in range(max(1, span)):
        c = lerp(MAGENTA, BLUE, i / max(1, span - 1))
        if horizontal:
            draw.line([(x0 + i, y0), (x0 + i, y1)], fill=c)
        else:
            draw.line([(x0, y0 + i), (x1, y0 + i)], fill=c)


def paste_icon(canvas: Image.Image, box: int, at) -> None:
    """The app icon, scaled and composited onto an opaque canvas."""
    icon = Image.open(ICON).convert("RGBA").resize((box, box), Image.LANCZOS)
    canvas.paste(icon, at, icon)


def build_sidebar() -> Image.Image:
    w, h = 164, 314
    img = nebula((w, h), crop=0.10, darken=0.55)

    paste_icon(img, 96, ((w - 96) // 2, 62))

    draw = ImageDraw.Draw(img)
    title = font(FONT_BOLD, 18)
    sub = font(FONT_REG, 10)

    # The whole block is centered vertically rather than hung from the top:
    # icon, rule, name, tagline come to about 190 of the panel's 314, so
    # hugging either end leaves a visibly dead third.
    #
    # The rule goes ABOVE the name, not between the name and the tagline. Below
    # it, eight pixels under a baseline, it stops reading as a divider and
    # starts reading as an underline on the word "Knife".
    accent_rule(draw, (w - 56) // 2, 176, (w + 56) // 2, 177)

    for line, y, f, fill in (
        ("Swiss RB", 190, title, TEXT),
        ("Knife", 210, title, TEXT),
        ("A Multi-Tool Application", 240, sub, TEXT_DIM),
    ):
        tw = draw.textbbox((0, 0), line, font=f)[2]
        draw.text(((w - tw) // 2, y), line, font=f, fill=fill)

    # The panel ends on purpose rather than just running out.
    accent_rule(draw, 0, h - 3, w, h - 1)
    return img


def build_header() -> Image.Image:
    w, h = 150, 57
    img = nebula((w, h), crop=0.10, darken=0.45)

    paste_icon(img, 41, (14, (h - 41) // 2))

    draw = ImageDraw.Draw(img)
    name = font(FONT_SEMI, 13)
    draw.text((64, 13), "Swiss RB", font=name, fill=TEXT)
    draw.text((64, 28), "Knife", font=name, fill=TEXT)

    # The left edge butts against the header's white background, so it gets a
    # rule of its own: without one the join reads as a rendering fault rather
    # than as an edge.
    accent_rule(draw, 0, 0, 2, h)
    accent_rule(draw, 0, h - 2, w, h - 1)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, image in (("sidebar.bmp", build_sidebar()), ("header.bmp", build_header())):
        path = OUT / name
        # 24-bit, no alpha. See the note at the top.
        image.convert("RGB").save(path, format="BMP")
        print(f"{path.relative_to(ROOT)}  {image.size[0]}x{image.size[1]}")


if __name__ == "__main__":
    main()
