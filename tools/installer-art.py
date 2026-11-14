"""설치 파일 그림 만들기.

    python3 tools/installer-art.py

src-tauri/installer/ 아래에 만든다.
  dmg-background.png   macOS 디스크 이미지 창 배경 (660×420pt, 144dpi 2배 해상도)
  nsis-sidebar.bmp     Windows 설치 프로그램 시작·완료 화면 왼쪽 그림 (164×314)
  nsis-header.bmp      Windows 설치 프로그램 위쪽 배너 (150×57)

앱 아이콘(icons/icon.png)과 같은 분위기: 짙은 남색 바탕, 파랑·보라 빛, 궤도 선, 반짝이.
캐릭터 그림은 넣지 않는다 (모델 배포 약관 때문에 설치 파일에는 모델을 넣지 않음).
글꼴은 macOS의 Apple SD Gothic Neo를 쓴다.
"""

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "src-tauri" / "installer"
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
WEIGHT = {"regular": 0, "medium": 2, "semibold": 4, "bold": 6}

NAVY_TOP = (20, 21, 38)
NAVY_BOTTOM = (11, 12, 22)
BLUE = (74, 125, 255)
VIOLET = (155, 107, 255)
CYAN = (110, 200, 255)
TEXT = (240, 241, 248)
MUTED = (150, 154, 178)


def font(size: float, weight: str = "regular") -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, round(size), index=WEIGHT[weight])


def gradient(size: tuple[int, int], top, bottom) -> Image.Image:
    width, height = size
    column = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / max(1, height - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return column.resize(size)


def glow(base: Image.Image, center, radius: float, color, strength: float) -> None:
    """부드러운 빛 번짐을 더한다 (가산 혼합)."""
    layer = Image.new("RGB", base.size, (0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx, cy = center
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=tuple(round(c * strength) for c in color))
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.55))
    base.paste(ImageChops.add(base, layer))


def orbit(base: Image.Image, box, width: float, color, alpha: int, angle: float = -12) -> None:
    """아이콘의 궤도 고리처럼 비스듬한 타원 선."""
    scale = 4  # 계단 없이 그리려고 크게 그려 줄인다
    w, h = base.size
    layer = Image.new("RGBA", (w * scale, h * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = (v * scale for v in box)
    draw.ellipse((x0, y0, x1, y1), outline=color + (alpha,), width=max(1, round(width * scale)))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    layer = layer.rotate(angle, center=(cx, cy), resample=Image.BICUBIC)
    layer = layer.resize((w, h), Image.LANCZOS)
    base.paste(Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB"))


def sparkle(draw: ImageDraw.ImageDraw, center, size: float, color, alpha: int) -> None:
    """네 갈래 반짝이 (아이콘 오른쪽 위 별)."""
    cx, cy = center
    thin = size * 0.18
    points = [
        (cx, cy - size), (cx + thin, cy - thin), (cx + size, cy), (cx + thin, cy + thin),
        (cx, cy + size), (cx - thin, cy + thin), (cx - size, cy), (cx - thin, cy - thin),
    ]
    draw.polygon(points, fill=color + (alpha,))


def stars(base: Image.Image, count: int, seed: int, scale: float, avoid=()) -> None:
    rng = random.Random(seed)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    w, h = base.size
    for _ in range(count):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        if any(abs(x - ax) < ar and abs(y - ay) < ar for ax, ay, ar in avoid):
            continue
        r = rng.choice([0.6, 0.8, 1.0, 1.3]) * scale
        a = rng.randint(40, 140)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(220, 225, 255, a))
    base.paste(Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB"))


def icon(size: int) -> Image.Image:
    return Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)


def paste_icon(base: Image.Image, size: int, center, shadow: bool = True) -> None:
    art = icon(size)
    x, y = round(center[0] - size / 2), round(center[1] - size / 2)
    if shadow:
        mask = art.getchannel("A").point(lambda a: a * 0.55)
        dark = Image.new("RGBA", art.size, (0, 0, 10, 255))
        dark.putalpha(mask)
        pad = size // 3
        holder = Image.new("RGBA", (size + pad * 2, size + pad * 2), (0, 0, 0, 0))
        holder.paste(dark, (pad, pad), dark)
        holder = holder.filter(ImageFilter.GaussianBlur(size * 0.09))
        rgba = base.convert("RGBA")
        rgba.alpha_composite(holder, (x - pad, y - pad + round(size * 0.06)))
        base.paste(rgba.convert("RGB"))
    rgba = base.convert("RGBA")
    rgba.alpha_composite(art, (x, y))
    base.paste(rgba.convert("RGB"))


def text(draw, xy, value, size, weight, color, anchor="la", spacing=0):
    draw.text(xy, value, font=font(size, weight), fill=color, anchor=anchor)


# ---------------------------------------------------------------- macOS dmg


def dmg_background() -> None:
    """660×420pt 창. 아이콘 자리는 tauri.conf.json의 appPosition(170,205)·applicationFolderPosition(490,205)."""
    s = 2  # 2배로 그리고 144dpi로 저장하면 Finder가 660×420pt로 선명하게 보여 준다
    w, h = 660 * s, 420 * s
    image = gradient((w, h), NAVY_TOP, NAVY_BOTTOM)
    glow(image, (170 * s, 205 * s), 150 * s, BLUE, 0.42)
    glow(image, (490 * s, 205 * s), 120 * s, VIOLET, 0.22)
    glow(image, (560 * s, 30 * s), 120 * s, VIOLET, 0.25)
    stars(image, 70, 7, s, avoid=[(170 * s, 205 * s, 90 * s), (490 * s, 205 * s, 90 * s)])
    orbit(image, (40 * s, 120 * s, 620 * s, 300 * s), 1.2 * s, (150, 170, 255), 42)

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    # 아이콘 사이 화살표: 점선 + 둥근 화살촉
    y = 205 * s
    x0, x1 = 262 * s, 392 * s
    dash, gap = 9 * s, 7 * s
    x = x0
    while x < x1 - 14 * s:
        draw.rounded_rectangle((x, y - 1.5 * s, min(x + dash, x1 - 14 * s), y + 1.5 * s), radius=1.5 * s, fill=(255, 255, 255, 120))
        x += dash + gap
    head = [(x1, y), (x1 - 15 * s, y - 10 * s), (x1 - 15 * s, y + 10 * s)]
    draw.polygon(head, fill=(255, 255, 255, 170))
    # Finder는 아이콘 이름을 검은 글씨로 쓰고 색을 바꿀 수 없다 → 이름 자리에 밝은 알약 바탕
    for cx in (170, 490):
        draw.rounded_rectangle(
            ((cx - 62) * s, 277 * s, (cx + 62) * s, 302 * s),
            radius=12.5 * s,
            fill=(236, 239, 252, 236),
            outline=(255, 255, 255, 255),
            width=max(1, round(0.6 * s)),
        )
    sparkle(draw, (612 * s, 52 * s), 9 * s, (235, 238, 255), 210)
    sparkle(draw, (590 * s, 78 * s), 4.5 * s, (235, 238, 255), 150)
    sparkle(draw, (64 * s, 352 * s), 5 * s, (200, 215, 255), 120)
    image.paste(Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB"))

    draw = ImageDraw.Draw(image)
    # 왼쪽 위 로고
    paste_icon(image, 30 * s, (44 * s, 40 * s), shadow=False)
    text(draw, (66 * s, 40 * s), "ScreenMate", 17 * s, "bold", TEXT, anchor="lm")
    # 아래 안내
    text(draw, (330 * s, 340 * s), "ScreenMate를 Applications 폴더로 끌어 놓으세요", 14 * s, "medium", (214, 218, 236), anchor="mm")
    text(draw, (330 * s, 364 * s), "그다음 응용 프로그램에서 ScreenMate를 열면 캐릭터가 바탕화면에 나와요", 11.5 * s, "regular", MUTED, anchor="mm")
    image.save(OUT / "dmg-background.png", dpi=(144, 144))


# ---------------------------------------------------------------- Windows NSIS


def nsis_sidebar() -> None:
    """시작·완료 화면 왼쪽 세로 그림 164×314. 오른쪽 본문은 흰 바탕이라 어두운 그림이 또렷하게 대비된다."""
    s = 4
    w, h = 164 * s, 314 * s
    image = gradient((w, h), (24, 25, 46), NAVY_BOTTOM)
    glow(image, (82 * s, 112 * s), 80 * s, BLUE, 0.55)
    glow(image, (150 * s, 20 * s), 70 * s, VIOLET, 0.35)
    glow(image, (10 * s, 300 * s), 60 * s, VIOLET, 0.2)
    stars(image, 45, 3, s * 0.9, avoid=[(82 * s, 112 * s, 50 * s)])
    orbit(image, (-30 * s, 70 * s, 194 * s, 160 * s), 1.1 * s, (160, 180, 255), 70, angle=-14)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    sparkle(draw, (136 * s, 52 * s), 7 * s, (235, 238, 255), 220)
    sparkle(draw, (122 * s, 70 * s), 3.5 * s, (235, 238, 255), 160)
    sparkle(draw, (28 * s, 262 * s), 4 * s, (200, 215, 255), 120)
    image.paste(Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB"))
    paste_icon(image, 76 * s, (82 * s, 112 * s))
    draw = ImageDraw.Draw(image)
    text(draw, (82 * s, 186 * s), "ScreenMate", 17 * s, "bold", TEXT, anchor="mm")
    text(draw, (82 * s, 207 * s), "바탕화면 위의 작은 친구", 9.5 * s, "medium", (178, 184, 214), anchor="mm")
    # 아래쪽 얇은 강조선
    draw.rounded_rectangle((70 * s, 226 * s, 94 * s, 227.5 * s), radius=1 * s, fill=(110, 140, 255))
    image.resize((164, 314), Image.LANCZOS).save(OUT / "nsis-sidebar.bmp")


def nsis_header() -> None:
    """위쪽 배너 150×57 (흰 바탕 위에 놓인다). 아이콘 + 이름."""
    s = 4
    w, h = 150 * s, 57 * s
    image = Image.new("RGB", (w, h), (255, 255, 255))
    paste_icon(image, 34 * s, (26 * s, 28.5 * s), shadow=False)
    draw = ImageDraw.Draw(image)
    text(draw, (50 * s, 28.5 * s), "ScreenMate", 15.5 * s, "bold", (24, 26, 44), anchor="lm")
    image.resize((150, 57), Image.LANCZOS).save(OUT / "nsis-header.bmp")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    dmg_background()
    nsis_sidebar()
    nsis_header()
    print("written:", ", ".join(sorted(path.name for path in OUT.iterdir())))
