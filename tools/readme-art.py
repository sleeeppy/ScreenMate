"""README 그림 만들기.

    python3 tools/readme-art.py

docs/images/ 아래에 만든다.
  icon.png                     앱 아이콘 (256px)
  headings/<이름>-{light,dark}.png   제목·섹션 제목 (GitHub 밝은·어두운 테마 글자색, 2배 해상도)
  models.png                   모델 줄 세우기 배너

배너의 캐릭터 그림은 앱 데이터의 썸네일(thumbnails/v3, 설정 창이 찍은 전신)을 쓴다.
먼저 앱에서 모델을 가져오고 설정 창을 한 번 열어 썸네일을 만들어 둔다.
배경은 설치 파일 그림(tools/installer-art.py)과 같은 분위기로 그린다.
"""

import importlib.util
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
FONT_DIR = ROOT / "node_modules" / "pretendard" / "dist" / "public" / "static"
THUMBNAILS = Path.home() / "Library" / "Application Support" / "dev.sleeeppy.screenmate" / "thumbnails" / "v3"

spec = importlib.util.spec_from_file_location("installer_art", ROOT / "tools" / "installer-art.py")
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)

# GitHub 본문 글자색
INK = {"light": (31, 35, 40), "dark": (240, 246, 252)}
SUB = {"light": (89, 99, 110), "dark": (145, 152, 161)}

HEADINGS = {
    "features": "주요 기능",
    "quiet": "방해하지 않아요",
    "inapp": "인앱",
    "settings": "설정",
    "models": "모델",
    "faq": "자주 묻는 질문",
    "install": "설치",
    "build": "직접 빌드하기",
    "credits": "모델과 크레딧",
}

# 배너에 세울 모델 (왼쪽부터). 가운데가 조금 크고 앞에 선다.
LINEUP = [
    "Sour式鏡音リン・レンVer.2.01--Sour式鏡音リンVer.2.01--White",
    "YYB式鏡音レンver1.00--YYB式鏡音レンver1.00--YYB式鏡音レンv1.00",
    "Sour式初音ミクVer.1.02--White",
    "YYB_Hatsune_Miku_default--YYB_Hatsune_Miku_default_1.0ver",
    "Sour式初音ミクVer.1.02--Black",
    "Sour式鏡音リン・レンVer.2.01--Sour式鏡音レンVer.2.01--Black",
    "Sour式鏡音リン・レンVer.2.01--Sour式鏡音リンVer.2.01--Black",
]


def font(size: float, weight: str = "Bold") -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / f"Pretendard-{weight}.otf"), round(size))


def text_image(parts, theme: str, scale: int = 2) -> Image.Image:
    """글자 조각들을 기준선에 맞춰 이어 붙인 투명 PNG. parts: (글자, 크기, 굵기, 색 이름)."""
    pad = 2 * scale
    fonts = [font(size * scale, weight) for _, size, weight, _ in parts]
    ascent = max(f.getmetrics()[0] for f in fonts)
    descent = max(f.getmetrics()[1] for f in fonts)
    widths = [f.getlength(value) for (value, *_), f in zip(parts, fonts)]
    image = Image.new("RGBA", (round(sum(widths)) + pad * 2, ascent + descent + pad * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    x = pad
    for (value, _, _, tone), f, width in zip(parts, fonts, widths):
        color = INK[theme] if tone == "ink" else SUB[theme]
        draw.text((x, pad + ascent), value, font=f, fill=color, anchor="ls")
        x += width
    return image


def headings() -> None:
    folder = OUT / "headings"
    folder.mkdir(parents=True, exist_ok=True)
    for theme in ("light", "dark"):
        title = text_image([("스크린메이트", 40, "Bold", "ink"), ("(ScreenMate)", 22, "SemiBold", "ink")], theme)
        title.save(folder / f"title-{theme}.png")
        for name, label in HEADINGS.items():
            text_image([(label, 22, "Bold", "ink")], theme).save(folder / f"{name}-{theme}.png")


def icon() -> None:
    Image.open(art.ICON).convert("RGBA").resize((256, 256), Image.LANCZOS).save(OUT / "icon.png")


def models_banner() -> None:
    s = 2
    w, h = 900 * s, 380 * s
    base = art.gradient((w, h), art.NAVY_TOP, art.NAVY_BOTTOM)
    small = base.resize((w // 4, h // 4))
    art.glow(small, (w * 0.5 / 4, h * 0.55 / 4), w * 0.16 / 4, art.BLUE, 0.42)
    art.glow(small, (w * 0.15 / 4, h * 0.2 / 4), w * 0.12 / 4, art.VIOLET, 0.25)
    art.glow(small, (w * 0.88 / 4, h * 0.25 / 4), w * 0.13 / 4, art.VIOLET, 0.28)
    base = small.resize((w, h), Image.BICUBIC)
    art.stars(base, 110, 21, s)
    art.orbit(base, (-0.05 * w, 0.22 * h, 1.05 * w, 0.98 * h), 1.2 * s, (150, 170, 255), 40, angle=-6)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    art.sparkle(draw, (0.93 * w, 0.16 * h), 9 * s, (235, 238, 255), 210)
    art.sparkle(draw, (0.9 * w, 0.27 * h), 4.5 * s, (235, 238, 255), 150)
    art.sparkle(draw, (0.07 * w, 0.72 * h), 5 * s, (200, 215, 255), 120)
    canvas = Image.alpha_composite(base.convert("RGBA"), layer)

    floor = h - 34 * s
    count = len(LINEUP)
    center = (count - 1) / 2
    step = w * 0.118
    order = sorted(range(count), key=lambda i: -abs(i - center))  # 바깥부터 그려 가운데가 앞에
    for i in order:
        figure = Image.open(THUMBNAILS / f"{LINEUP[i]}.png").convert("RGBA")
        box = figure.getchannel("A").point(lambda a: 255 if a > 12 else 0).getbbox()
        figure = figure.crop(box)
        distance = abs(i - center)
        height = h * (0.86 - 0.035 * distance)
        figure = figure.resize((round(figure.width * height / figure.height), round(height)), Image.LANCZOS)
        cx = w / 2 + (i - center) * step
        x = round(cx - figure.width / 2)
        y = round(floor - figure.height + distance * 3 * s)
        shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow).ellipse(
            (cx - figure.width * 0.42, y + figure.height - 7 * s, cx + figure.width * 0.42, y + figure.height + 7 * s),
            fill=(0, 0, 10, 150),
        )
        canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6 * s)))
        if distance > 0:
            # 뒤에 선 캐릭터는 살짝 어둡게 (깊이감)
            dim = Image.new("RGBA", figure.size, (12, 14, 30, round(40 * distance)))
            dim.putalpha(Image.eval(figure.getchannel("A"), lambda a: a * 0.12 * distance))
            figure = Image.alpha_composite(figure, dim)
        canvas.alpha_composite(figure, (x, y))

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=22 * s, fill=255)
    canvas.putalpha(mask)
    canvas.save(OUT / "models.png")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icon()
    headings()
    models_banner()
    print("saved", OUT)
