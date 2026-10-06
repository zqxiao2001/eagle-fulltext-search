# -*- coding: utf-8 -*-
"""生成插件图标 logo.png（128×128）。
风格：四级灰阶、极简：浅灰圆角底 + 深灰放大镜 + 镜内两条短横线（暗示「文本」）。
用 4 倍超采样绘制再缩回，保证边缘干净（无锯齿）。"""
from PIL import Image, ImageDraw
import os

S = 4
W = 128 * S
BG = (242, 242, 239, 255)      # #F2F2EF
EDGE = (220, 220, 216, 255)    # #DCDCD8
DARK = (51, 57, 61, 255)       # #33393D
MID = (138, 143, 147, 255)     # #8A8F93

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
pad = 4 * S
d.rounded_rectangle([pad, pad, W - pad, W - pad], radius=26 * S, fill=BG, outline=EDGE, width=2 * S)

# 放大镜：圆环 + 手柄
cx, cy, r = 54 * S, 52 * S, 22 * S
ring = 6 * S
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=DARK, width=ring)
hw = 5 * S
import math
a = math.radians(45)
x1, y1 = cx + (r + ring / 2 - 1 * S) * math.cos(a), cy + (r + ring / 2 - 1 * S) * math.sin(a)
x2, y2 = x1 + 20 * S * math.cos(a), y1 + 20 * S * math.sin(a)
d.line([x1, y1, x2, y2], fill=DARK, width=hw)
d.ellipse([x2 - hw / 2, y2 - hw / 2, x2 + hw / 2, y2 + hw / 2], fill=DARK)

# 镜内三条短横线（表示被检索的文本行）
for i, (wy, wl) in enumerate([(-7, 22), (0, 26), (7, 16)]):
    y = cy + wy * S
    d.line([cx - wl * S / 2, y, cx + wl * S / 2, y], fill=MID, width=3 * S)

img = img.resize((128, 128), Image.LANCZOS)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logo.png')
img.save(out)
print('已生成', out, os.path.getsize(out), 'bytes')
