"""Generate the extension's PNG icons. Run once: `python3 make_icons.py`."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).parent
TG_BLUE = (36, 129, 204, 255)
TG_BLUE_DARK = (31, 116, 184, 255)
WHITE = (255, 255, 255, 255)
SHADOW = (0, 0, 0, 60)


def render(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square background (Telegram blue)
    radius = int(s * 0.22)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=TG_BLUE)

    # Clipboard body (white rounded rect)
    pad_x = int(s * 0.22)
    pad_top = int(s * 0.22)
    pad_bot = int(s * 0.12)
    body = (pad_x, pad_top, s - pad_x, s - pad_bot)
    d.rounded_rectangle(body, radius=int(s * 0.06), fill=WHITE)

    # Clip on top (small darker rectangle)
    clip_w = int(s * 0.30)
    clip_h = int(s * 0.10)
    cx = s // 2
    clip = (cx - clip_w // 2, pad_top - clip_h // 2,
            cx + clip_w // 2, pad_top + clip_h // 2)
    d.rounded_rectangle(clip, radius=int(s * 0.025), fill=TG_BLUE_DARK)

    # Three text lines on the clipboard
    line_x1 = pad_x + int(s * 0.08)
    line_x2 = s - pad_x - int(s * 0.08)
    line_h = max(2, int(s * 0.035))
    base_y = pad_top + int(s * 0.18)
    gap = int(s * 0.10)
    for i in range(3):
        y = base_y + i * gap
        x2 = line_x2 if i < 2 else line_x1 + int((line_x2 - line_x1) * 0.55)
        d.rounded_rectangle((line_x1, y, x2, y + line_h),
                            radius=line_h // 2, fill=TG_BLUE_DARK)

    img = img.resize((size, size), Image.LANCZOS)
    return img


for sz in (16, 32, 48, 128):
    out = OUT / f"icon{sz}.png"
    render(sz).save(out, "PNG", optimize=True)
    print(f"wrote {out}")
