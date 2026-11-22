"""README 커버(docs/images/cover.png) 만들기.

    python3 tools/cover-art.py

처음 만든 키 비주얼(커밋 476d2f3의 cover.png, 앱으로 렌더한 린·렌·미쿠 합성)을 바탕으로 쓴다.
글자·로고를 지우고, 캐릭터와 창을 GrabCut으로 오려 낸 뒤 그 자리를 배경으로 메운다.
오린 캐릭터는 조금 줄여 오른쪽 가운데에 다시 앉힌다.
로고(아이콘 + ScreenMate)는 왼쪽 가운데, 지원 OS는 왼쪽 아래, 재생 버튼은 한가운데에 둔다.

    python3 tools/cover-art.py --plain <경로.webp>   # 재생 버튼 없는 그림도 (포트폴리오용)
"""

import argparse
import random
import subprocess
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images" / "cover.png"
ICON = ROOT / "src-tauri" / "icons" / "icon.png"
FONT_DIR = ROOT / "node_modules" / "pretendard" / "dist" / "public" / "static"
BASE_COMMIT = "476d2f3"

W, H = 1600, 900
S = 2  # 글자·도형은 2배로 그려 줄인다

# 원본에서 지울 글자·로고 영역 (원본 좌표)
ERASE = [
    (120, 290, 232, 400),  # 아이콘
    (118, 395, 740, 510),  # ScreenMate + 반짝이
    (122, 512, 690, 552),  # 소개 문구와 앞의 선
    (115, 796, 355, 826),  # MACOS · WINDOWS
]

# GrabCut 힌트 (원본 좌표). 이 사각형 밖은 모두 배경이다.
CUT_BOX = (735, 215, 1600, 898)
SURE_BG = [
    (1160, 215, 1345, 505), (735, 215, 748, 898), (748, 215, 772, 330), (892, 215, 1010, 370),
    (818, 650, 842, 850), (895, 600, 908, 870), (905, 857, 1400, 898), (1515, 410, 1530, 470),
    (748, 330, 777, 505), (786, 372, 800, 395), (1520, 470, 1532, 515), (1556, 470, 1580, 505),
]
SURE_FG = [
    (912, 520, 1404, 848),  # 창
    (808, 300, 860, 600), (788, 600, 808, 860), (852, 600, 872, 860), (784, 430, 794, 540), (762, 520, 775, 560),  # 렌
    (1040, 260, 1100, 560), (1110, 560, 1140, 700),  # 린
    (1400, 330, 1460, 560), (1415, 560, 1470, 870), (1555, 560, 1570, 680),  # 미쿠
]

# 제목 글자 뒤의 보랏빛 번짐 (원본 좌표)
TITLE_GLOW = (80, 260, 780, 590)

# 렌 옆의 빛망울 (원본 좌표, 반지름). 캐릭터 자리를 메울 때 이 색이 번져 얼룩이 생기므로 같이 지운다.
BOKEH = [(685, 377, 14), (762, 375, 14), (737, 507, 30), (740, 627, 22)]

CAST_SCALE = 0.8  # 캐릭터 묶음 크기
CAST_RIGHT = 70  # 오른쪽 여백
CAST_CENTER_Y = 470  # 묶음 세로 가운데
BACK_DIM = 235  # 캐릭터 뒤 배경을 누르는 세기 (0~255)


def font(size: float, weight: str) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / f"Pretendard-{weight}.otf"), round(size))


def load_original() -> np.ndarray:
    data = subprocess.run(
        ["git", "show", f"{BASE_COMMIT}:docs/images/cover.png"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    return cv2.cvtColor(np.array(Image.open(BytesIO(data)).convert("RGB")), cv2.COLOR_RGB2BGR)


def cast_mask(bgr: np.ndarray) -> np.ndarray:
    mask = np.full(bgr.shape[:2], cv2.GC_BGD, np.uint8)
    x0, y0, x1, y1 = CUT_BOX
    mask[y0:y1, x0:x1] = cv2.GC_PR_BGD
    for x0, y0, x1, y1 in SURE_BG:
        mask[y0:y1, x0:x1] = cv2.GC_BGD
    for x0, y0, x1, y1 in SURE_FG:
        mask[y0:y1, x0:x1] = cv2.GC_FGD
    cv2.grabCut(bgr, mask, None, np.zeros((1, 65)), np.zeros((1, 65)), 10, cv2.GC_INIT_WITH_MASK)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fg)
    keep = np.zeros_like(fg)
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] > 400:  # 떨어진 부스러기 버리기
            keep[labels == i] = 255
    return keep


def fill(bgr: np.ndarray, mask: np.ndarray, grow: int) -> np.ndarray:
    """mask 자리를 주변 배경으로 메운다. 둘레의 빛 번짐까지 지우려고 grow 만큼 넓혀 메운다.
    지운 자리의 색은 전혀 섞지 않고 바깥 배경만 가중 평균한다(정규화 블러). 좁은 블러로 못 닿는 곳은 넓은 블러로 채운다."""
    wide = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow * 2 + 1, grow * 2 + 1)))
    valid = (wide == 0).astype(np.float32)
    image = bgr.astype(np.float32)
    small = lambda a: cv2.resize(a, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    big = lambda a: cv2.resize(a, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_CUBIC)
    v, im = small(valid), small(image * valid[..., None])
    result = np.zeros_like(im)
    weight = np.zeros_like(v)
    for sigma in (10, 30, 90):  # 축소한 크기 기준
        bw = cv2.GaussianBlur(v, (0, 0), sigma)
        bi = cv2.GaussianBlur(im, (0, 0), sigma)
        est = bi / np.maximum(bw, 1e-6)[..., None]
        take = np.clip(bw * 4, 0, 1) * (1 - weight)
        result += est * take[..., None]
        weight += take
    smooth = big(result / np.maximum(weight, 1e-6)[..., None])
    blend = cv2.GaussianBlur(wide, (0, 0), grow * 0.3).astype(np.float32)[..., None] / 255
    blend = np.maximum(blend, (wide > 0)[..., None].astype(np.float32))
    return np.clip(image * (1 - blend) + smooth * blend, 0, 255).astype(np.uint8)


def stars(image: Image.Image, area, count: int, seed: int) -> None:
    """메운 자리에도 별을 다시 뿌린다."""
    rng = random.Random(seed)
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = area
    for _ in range(count):
        x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
        r = rng.choice([0.6, 0.8, 1.0, 1.3])
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(220, 225, 255, rng.randint(40, 150)))
    image.alpha_composite(layer)


def scene() -> Image.Image:
    bgr = load_original()
    text = np.zeros(bgr.shape[:2], np.uint8)
    for x0, y0, x1, y1 in ERASE:
        text[y0:y1, x0:x1] = 255
    text[:24, :24] = text[-24:, :24] = text[:24, -24:] = text[-24:, -24:] = 255  # 둥근 모서리 자리
    # 글자 둘레의 빛 번짐과 빛망울까지 한 번에 지워야 메운 자리에 얼룩이 남지 않는다
    cast = cast_mask(bgr)
    hole = np.maximum(text, cast)
    x0, y0, x1, y1 = TITLE_GLOW
    hole[y0:y1, x0:x1] = 255
    for x, y, r in BOKEH:
        cv2.circle(hole, (x, y), r, 255, -1)
    hole[CUT_BOX[1]:, CUT_BOX[0] - 60:CUT_BOX[0] + 60] = 255  # 렌 왼쪽에 번진 빛
    hole[800:, CUT_BOX[0]:] = 255  # 발밑 그림자
    hole[CUT_BOX[1]:, W - 60:] = 255  # 오른쪽 끝에 걸친 미쿠 머리카락 그늘
    background = fill(bgr, hole, 50)
    clean = cv2.inpaint(bgr, text, 9, cv2.INPAINT_TELEA)  # 오릴 캐릭터 쪽에는 글자가 없다
    back = Image.fromarray(cv2.cvtColor(background, cv2.COLOR_BGR2RGB)).convert("RGBA")
    stars(back, CUT_BOX, 70, 7)
    stars(back, TITLE_GLOW, 45, 11)

    # 캐릭터 오리기 (가장자리 살짝 부드럽게)
    figure = Image.fromarray(cv2.cvtColor(clean, cv2.COLOR_BGR2RGB)).convert("RGBA")
    figure.putalpha(Image.fromarray(cast).filter(ImageFilter.GaussianBlur(0.8)))
    figure = figure.crop(Image.fromarray(cast).getbbox())
    size = (round(figure.width * CAST_SCALE), round(figure.height * CAST_SCALE))
    figure = figure.resize(size, Image.LANCZOS)
    x = W - CAST_RIGHT - figure.width
    y = CAST_CENTER_Y - figure.height // 2

    # 캐릭터 뒤를 어둡게 눌러 밝은 보랏빛 배경에서 캐릭터가 떠 보이게 한다. 발밑에는 그림자.
    dim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(dim).ellipse(
        (x - figure.width * 0.12, y - figure.height * 0.1, x + figure.width * 1.12, y + figure.height * 1.15),
        fill=(10, 9, 28, BACK_DIM),
    )
    back.alpha_composite(dim.filter(ImageFilter.GaussianBlur(110)))
    floor = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(floor).ellipse(
        (x + figure.width * 0.02, y + figure.height - 16, x + figure.width * 0.98, y + figure.height + 22),
        fill=(4, 4, 16, 130),
    )
    back.alpha_composite(floor.filter(ImageFilter.GaussianBlur(14)))
    back.alpha_composite(figure, (x, y))
    return back


def gradient_text(value: str, f: ImageFont.FreeTypeFont, top, bottom) -> Image.Image:
    ascent, descent = f.getmetrics()
    width = round(f.getlength(value)) + 8 * S
    mask = Image.new("L", (width, ascent + descent + 8 * S), 0)
    ImageDraw.Draw(mask).text((4 * S, 4 * S), value, font=f, fill=255)
    fill_ = Image.new("RGBA", mask.size)
    draw = ImageDraw.Draw(fill_)
    for y in range(mask.height):
        t = y / max(1, mask.height - 1)
        draw.line([(0, y), (mask.width, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    fill_.putalpha(mask)
    return fill_


def glow_of(image: Image.Image, color, radius: float, strength: float) -> tuple[Image.Image, int]:
    """번짐이 잘리지 않게 여백을 두고 그린다. (그림, 여백)을 돌려준다."""
    pad = round(radius * 3)
    padded = Image.new("RGBA", (image.width + pad * 2, image.height + pad * 2), (0, 0, 0, 0))
    padded.alpha_composite(image, (pad, pad))
    alpha = padded.getchannel("A").filter(ImageFilter.GaussianBlur(radius)).point(lambda a: round(a * strength))
    layer = Image.new("RGBA", padded.size, color + (0,))
    layer.putalpha(alpha)
    return layer, pad


LEFT = 104  # 로고·지원 OS 왼쪽 줄


def logo(canvas: Image.Image) -> None:
    """왼쪽 가운데: 아이콘 + 오른쪽에 ScreenMate, 그 아래 소개 문구."""
    big = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    left, top = LEFT * S, 372 * S  # 아이콘~소개 문구 묶음이 세로 가운데쯤
    icon_size = 92 * S
    icon = Image.open(ICON).convert("RGBA").resize((icon_size, icon_size), Image.LANCZOS)
    halo, pad = glow_of(icon, (110, 120, 255), 18 * S, 0.55)
    big.alpha_composite(halo, (left - pad, top + 6 * S - pad))
    big.alpha_composite(icon, (left, top))

    title = gradient_text("ScreenMate", font(68 * S, "ExtraBold"), (255, 255, 255), (196, 200, 255))
    tx = left + icon_size + 20 * S
    ty = top + icon_size // 2 - title.height // 2 - 8 * S
    halo, pad = glow_of(title, (130, 120, 255), 16 * S, 0.5)
    big.alpha_composite(halo, (tx - pad, ty - pad))
    big.alpha_composite(title, (tx, ty))

    draw = ImageDraw.Draw(big)
    draw.text((left + 2 * S, top + icon_size + 30 * S), "바탕화면 위에서 살아 움직이는 나의 MMD 캐릭터 친구들",
              font=font(21 * S, "Medium"), fill=(214, 218, 245, 235), anchor="lm")
    canvas.alpha_composite(big.resize((W, H), Image.LANCZOS))


def platforms(canvas: Image.Image) -> None:
    """왼쪽 아래: 지원 OS."""
    big = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    ImageDraw.Draw(big).text((LEFT * S + 2 * S, H * S - 128 * S), "macOS  ·  Windows", font=font(17 * S, "Medium"),
                             fill=(190, 195, 228, 235), anchor="lm")
    canvas.alpha_composite(big.resize((W, H), Image.LANCZOS))


def play_overlay(canvas: Image.Image) -> None:
    """가운데 재생 버튼 (README에서 누르면 유튜브 트레일러로 간다). 뒤를 흐리게 비치는 어두운 유리 원."""
    r = 62
    cx, cy = W // 2, H // 2
    big = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    shadow = Image.new("RGBA", big.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(((cx - r) * S, (cy - r + 8) * S, (cx + r) * S, (cy + r + 8) * S), fill=(0, 0, 10, 120))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14 * S)).resize((W, H), Image.LANCZOS))

    # 원 안은 뒤 그림을 흐리게 해서 어둡게 덮는다
    blurred = canvas.filter(ImageFilter.GaussianBlur(8))
    disc = Image.new("L", big.size, 0)
    ImageDraw.Draw(disc).ellipse(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S), fill=255)
    disc = disc.resize((W, H), Image.LANCZOS)
    canvas.paste(blurred, (0, 0), disc)
    tint = Image.new("RGBA", (W, H), (40, 36, 46, 0))
    tint.putalpha(disc.point(lambda a: a * 165 // 255))
    canvas.alpha_composite(tint)

    draw = ImageDraw.Draw(big)
    draw.ellipse(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S), outline=(255, 255, 255, 185), width=round(2.5 * S))
    # 둥근 모서리 삼각형. 무게중심이 원 중심에 오도록 오른쪽으로 조금 민다.
    t = 29 * S
    ox = 4 * S
    pts = [(cx * S - t * 0.78 + ox, cy * S - t), (cx * S - t * 0.78 + ox, cy * S + t), (cx * S + t * 0.95 + ox, cy * S)]
    tri = Image.new("L", big.size, 0)
    ImageDraw.Draw(tri).polygon(pts, fill=255)
    round_ = 4 * S
    tri = tri.filter(ImageFilter.MinFilter(round_ * 2 + 1)).filter(ImageFilter.MaxFilter(round_ * 2 + 1))
    tri = tri.filter(ImageFilter.GaussianBlur(round_ * 0.8)).point(lambda a: 0 if a < 128 else 255)
    white = Image.new("RGBA", big.size, (255, 255, 255, 250))
    big.paste(white, (0, 0), tri)
    canvas.alpha_composite(big.resize((W, H), Image.LANCZOS))


def round_corners(canvas: Image.Image) -> None:
    mask = Image.new("L", (W * S, H * S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W * S - 1, H * S - 1), radius=22 * S, fill=255)
    canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), mask.resize((W, H), Image.LANCZOS)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plain", type=Path, help="재생 버튼·둥근 모서리 없는 그림도 저장 (예: 포트폴리오용 .webp)")
    parser.add_argument("--plain-width", type=int, default=1280)
    args = parser.parse_args()

    canvas = scene()
    logo(canvas)
    platforms(canvas)
    if args.plain:
        size = (args.plain_width, round(args.plain_width * H / W))
        plain = canvas.convert("RGB").resize(size, Image.LANCZOS)
        plain.save(args.plain, quality=88, method=6) if args.plain.suffix == ".webp" else plain.save(args.plain)
        print("saved", args.plain)

    play_overlay(canvas)
    round_corners(canvas)
    canvas.save(OUT, optimize=True)
    print("saved", OUT)


if __name__ == "__main__":
    main()
