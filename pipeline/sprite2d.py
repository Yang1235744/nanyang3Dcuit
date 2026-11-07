#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""南阳 3Dcuit · 2D 素材管线

把一张角色立绘 / 参考图转换成 RPG Maker VX / VX Ace 可直接使用的行走图：
3 帧 x 4 方向 = 12 帧，单帧默认 32x48，整张图 96x192。

设计约束：
- 只依赖 Pillow，纯 CPU 完成，不加载任何模型权重，弱显卡 / 核显也能跑；
- 自动抠图按“四角背景色 + 色差阈值”，所以生成参考图时请用纯色背景（推荐洋红 #FF00FF）；
- 缺少背面 / 侧面视图时会用占位推导（镜像 / 压暗），并在终端明确标注，不假装有真数据。

常用命令：
    python sprite2d.py --front hero_front.png --back hero_back.png --side hero_side.png \
        --out hero_walk.png --preview hero_walk_preview.png

生成图提示词模板（直接用 AI 出图时）：
    RPG Maker 角色参考图：<角色描述>，正面全身站立，像素风，粗描边，
    纯洋红背景 #FF00FF，无阴影、无文字，人物居中，便于抠图后缩成 32x48 行走图。
"""

from __future__ import annotations

import argparse
import colorsys
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

# 方向顺序必须与 RPG Maker VX 图集一致：第 1 行朝下、第 2 行朝左、第 3 行朝右、第 4 行朝上
DIRECTIONS = ("down", "left", "right", "up")
FRAME_PRESETS = {
    "vx": (32, 48),        # RPG Maker VX / VX Ace
    "vxxp": (32, 32),      # XP 风格，单帧 32x32
    "mv": (48, 48),        # RPG Maker MV / MZ 默认角色
}


def load_rgba(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def has_alpha(im: Image.Image) -> bool:
    return im.getchannel("A").getextrema()[0] < 250


def border_is_uniform(im: Image.Image, tol: int) -> bool:
    """抽查边框 12 个点，判断背景是否是纯色。不均匀说明这张图不适合色差抠图。"""
    w, h = im.size
    bg = im.getpixel((0, 0))[:3]
    points = []
    for x in (0, w // 4, w // 2, 3 * w // 4, w - 1):
        points.append((x, 0))
        points.append((x, h - 1))
    for y in (h // 4, h // 2, 3 * h // 4):
        points.append((0, y))
        points.append((w - 1, y))
    bad = 0
    for xy in points:
        p = im.getpixel(xy)[:3]
        if max(abs(p[i] - bg[i]) for i in range(3)) > tol * 2:
            bad += 1
    return bad <= len(points) * 0.3


def clear_corner_watermark(im: Image.Image, frac_w: float = 0.28, frac_h: float = 0.12) -> Image.Image:
    """清掉 AI 出图右下角的水印块（那块区域本来也不该有角色内容）。"""
    w, h = im.size
    box = (int(w * (1 - frac_w)), int(h * (1 - frac_h)), w, h)
    ImageDraw.Draw(im).rectangle(box, fill=(0, 0, 0, 0))
    return im


def detect_screen_hue(im: Image.Image) -> float | None:
    """从上边框和左边框采样，判断是不是洋红 / 绿幕，返回**实测**色相角（0-360）。

    注意返回的是实测值，不是标准 300°。AI 出图的“洋红”往往偏到 320° 左右，
    如果硬套标准值再给窄容差，边缘和渐变区就会抠不掉。
    """
    w, h = im.size
    samples = []
    step = max(1, w // 40)
    for x in range(0, w, step):
        samples.append(im.getpixel((x, 0))[:3])
    step = max(1, h // 40)
    for y in range(0, h, step):
        samples.append(im.getpixel((0, y))[:3])
    r = sum(s[0] for s in samples) / len(samples) / 255
    g = sum(s[1] for s in samples) / len(samples) / 255
    b = sum(s[2] for s in samples) / len(samples) / 255
    hue, sat, val = colorsys.rgb_to_hsv(r, g, b)
    if sat < 0.35 or val < 0.25:
        return None
    angle = hue * 360
    for target in (300.0, 120.0):  # 洋红幕 / 绿幕
        if min(abs(angle - target), 360 - abs(angle - target)) <= 30:
            return angle
    return None


def strip_background(
    im: Image.Image,
    tol: int = 26,
    soft: float = 2.2,
    keep_corner: bool = False,
) -> tuple[Image.Image, str]:
    """抠图：优先按色相抠洋红 / 绿幕（能扛住背景渐变），否则退回色差抠图。

    返回 (RGBA 图, 提示信息)。
    """
    im = im.copy().convert("RGBA")
    if has_alpha(im):
        return im, "原图已带透明通道，跳过抠图"
    if not keep_corner:
        im = clear_corner_watermark(im)

    screen = detect_screen_hue(im)
    if screen is not None:
        hsv = im.convert("HSV")
        h_ch, s_ch, v_ch = hsv.split()
        tol_deg = 20

        def hue_is_bg(v: int) -> int:
            d = abs(v * 360 / 255 - screen)
            d = min(d, 360 - d)
            return 255 if d <= tol_deg else 0

        # 色相接近幕布 + 足够艳 + 足够亮，才算“背景候选”，避免误删黑发和白衣
        bg_h = h_ch.point(hue_is_bg)
        bg_s = s_ch.point(lambda v: 255 if v >= 85 else 0)
        bg_v = v_ch.point(lambda v: 255 if v >= 55 else 0)
        key = ImageChops.multiply(ImageChops.multiply(bg_h, bg_s), bg_v)
        key = key.filter(ImageFilter.GaussianBlur(0.8))  # 软化边缘，避免硬锯齿
        keep = ImageChops.invert(key)
        alpha = ImageChops.multiply(im.getchannel("A"), keep)
        out = im.copy()
        out.putalpha(alpha)
        return out, f"已按色相 {screen:.0f}° 抠幕布（适应背景渐变）"

    # 兜底：非标准幕布，按边角颜色做色差抠图
    bg = im.getpixel((0, 0))[:3]
    rgb = im.convert("RGB")
    diff = ImageChops.difference(rgb, Image.new("RGB", im.size, bg))
    r, g, b = diff.split()
    diff_max = ImageChops.lighter(ImageChops.lighter(r, g), b)
    hi = max(tol + 1, int(tol * soft))
    mul = diff_max.point(
        lambda v: 0 if v <= tol else (255 if v >= hi else int((v - tol) * 255 / (hi - tol)))
    )
    alpha = ImageChops.multiply(im.getchannel("A"), mul)
    out = im.copy()
    out.putalpha(alpha)
    note = "已按背景色色差抠图"
    if not border_is_uniform(im, tol):
        note += "（背景有渐变，边缘可能不干净）"
    return out, note


def content_bbox(im: Image.Image, alpha_thr: int = 40, occupancy: float = 0.03) -> tuple[int, int, int, int] | None:
    """按“行 / 列不透明像素占比”求角色包围盒，能过滤 JPEG 噪点和细碎背景残留。

    直接 getbbox 会被 1 像素噪点撑满整张图，导致角色被缩成一小团。
    """
    alpha = im.getchannel("A")
    w, h = im.size
    mask = alpha.point(lambda v: 255 if v >= alpha_thr else 0)
    row_prof = mask.resize((1, h), Image.BOX)  # 每行的平均不透明度
    col_prof = mask.resize((w, 1), Image.BOX)
    limit = int(255 * occupancy)

    rows = [y for y in range(h) if row_prof.getpixel((0, y)) > limit]
    cols = [x for x in range(w) if col_prof.getpixel((x, 0)) > limit]
    if not rows or not cols:
        return None
    return cols[0], rows[0], cols[-1] + 1, rows[-1] + 1


def fit_into_frame(subject: Image.Image, fw: int, fh: int, height_ratio: float) -> Image.Image:
    """裁剪到不透明内容，按比例缩放，水平居中、脚底贴齐帧底。"""
    bbox = content_bbox(subject)
    if not bbox:
        return Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    subject = subject.crop(bbox)
    sw, sh = subject.size
    scale = min(fh * height_ratio / sh, fw * 0.98 / sw)
    nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
    resized = subject.resize((nw, nh), Image.LANCZOS)
    frame = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    frame.paste(resized, ((fw - nw) // 2, fh - nh), resized)
    return frame


def reduce_colors(frame: Image.Image, colors: int) -> Image.Image:
    """可选：压成有限色板，更像手绘像素风。0 表示不处理。"""
    if colors <= 0:
        return frame
    # RGBA 必须用 FASTOCTREE，MEDIANCUT 只支持 RGB，会把透明区混进色板导致角色发灰
    return frame.quantize(colors=colors, method=Image.FASTOCTREE).convert("RGBA")


def bob_frame(frame: Image.Image, squash: float) -> Image.Image:
    """以脚底为锚点做垂直压扁 / 拉伸，得到 3 帧走路的身体起伏，脚不离地。"""
    w, h = frame.size
    if abs(squash - 1.0) < 0.005:
        return frame.copy()
    nh = max(1, round(h * squash))
    content = frame.resize((w, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    # 压扁或拉伸后始终贴底，避免角色“悬空”
    canvas.paste(content, (0, h - nh), content)
    return canvas


def flip(frame: Image.Image) -> Image.Image:
    return frame.transpose(Image.FLIP_LEFT_RIGHT)


def darken(frame: Image.Image, factor: float) -> Image.Image:
    from PIL import ImageEnhance

    rgb = ImageEnhance.Brightness(frame.convert("RGB")).enhance(factor).convert("RGBA")
    rgb.putalpha(frame.getchannel("A"))
    return rgb


def build_sheet(
    views: dict[str, Image.Image],
    fw: int,
    fh: int,
    height_ratio: float,
    tol: int,
    colors: int,
    log: list[str],
    keep_corner: bool = False,
) -> Image.Image:
    """views 至少要有 front；back / side 缺失时用推导占位。"""
    prepared: dict[str, Image.Image] = {}
    for key, im in views.items():
        cleaned, msg = strip_background(im, tol, keep_corner=keep_corner)
        log.append(f"[{key}] {msg}")
        prepared[key] = reduce_colors(fit_into_frame(cleaned, fw, fh, height_ratio), colors)

    front = prepared["front"]
    # 右向 = 侧面原图；左向 = 右向镜像。都没有就用正面镜像，并在日志里标注是占位。
    if "side" in prepared:
        right = prepared["side"]
        left = flip(right)
    else:
        right = flip(front)
        left = front
        log.append("[side] 未提供侧面图，已用正面 / 镜像占位")
    if "back" in prepared:
        back = prepared["back"]
    else:
        back = darken(flip(front), 0.82)
        log.append("[back] 未提供背面图，已用镜像 + 压暗占位")

    bases = {"down": front, "left": left, "right": right, "up": back}
    sheet = Image.new("RGBA", (fw * 3, fh * 4), (0, 0, 0, 0))
    for row, name in enumerate(DIRECTIONS):
        base = bases[name]
        frames = (bob_frame(base, 1.0), bob_frame(base, 0.955), bob_frame(base, 1.02))
        for col, frame in enumerate(frames):
            sheet.paste(frame, (col * fw, row * fh), frame)
    return sheet


def validate(sheet: Image.Image, fw: int, fh: int, log: list[str]) -> None:
    expect = (fw * 3, fh * 4)
    log.append(f"[校验] 图集尺寸 {sheet.size[0]}x{sheet.size[1]}，期望 {expect[0]}x{expect[1]} "
               f"{'✔' if sheet.size == expect else '✘'}")
    for row, name in enumerate(DIRECTIONS):
        row_img = sheet.crop((0, row * fh, fw * 3, (row + 1) * fh))
        bbox = content_bbox(row_img, occupancy=0.02)
        if not bbox:
            log.append(f"[校验] {name}: 空行 ✘")
            continue
        content_h = bbox[3] - bbox[1]
        # 只要角色贴到帧底或差 1px 以内，就认为脚底对齐
        aligned = bbox[3] >= fh - 2
        log.append(f"[校验] {name}: 内容高 {content_h}px，脚底对齐 {'✔' if aligned else '✘ 悬浮'}")


def make_preview(sheet: Image.Image, frame_size: tuple[int, int], scale: int = 4) -> Image.Image:
    """带棋盘格和方向标签的放大预览，方便肉眼检查。"""
    fw, fh = frame_size
    margin, label_w = 8, 46
    w, h = fw * 3 * scale, fh * 4 * scale
    canvas = Image.new("RGBA", (w + label_w + margin, h + margin * 2), (26, 32, 44, 255))
    checker = Image.new("RGBA", (w, h), (38, 46, 60, 255))
    d = ImageDraw.Draw(checker)
    step = 8
    for y in range(0, h, step):
        for x in range(0, w, step):
            if (x // step + y // step) % 2:
                d.rectangle((x, y, x + step - 1, y + step - 1), fill=(50, 58, 72, 255))
    canvas.paste(checker, (label_w, margin))
    big = sheet.resize((w, h), Image.NEAREST)
    canvas.alpha_composite(big, (label_w, margin))

    font = ImageFont.load_default()
    for row, name in enumerate(DIRECTIONS):
        y = margin + row * fh * scale + fh * scale // 2 - 6
        d2 = ImageDraw.Draw(canvas)
        d2.text((8, y), name, fill=(120, 210, 255, 255), font=font)
    return canvas


def parse_frame(value: str) -> tuple[int, int]:
    if value in FRAME_PRESETS:
        return FRAME_PRESETS[value]
    if "x" in value:
        w, h = value.lower().split("x", 1)
        return int(w), int(h)
    raise argparse.ArgumentTypeError("帧尺寸请写成 32x48，或使用预设 vx / vxmv / vxmv")


def main() -> int:
    parser = argparse.ArgumentParser(description="角色图 -> RPG Maker 行走图（3 帧 x 4 方向）")
    parser.add_argument("--front", required=True, help="正面（朝下）参考图")
    parser.add_argument("--back", help="背面（朝上）参考图，可选")
    parser.add_argument("--side", help="侧面（朝右）参考图，可选")
    parser.add_argument("--out", required=True, help="输出 PNG 路径")
    parser.add_argument("--preview", help="输出放大预览图路径，可选")
    parser.add_argument("--frame", default="vx", type=parse_frame, help="单帧尺寸，默认 vx=32x48")
    parser.add_argument("--height-ratio", type=float, default=0.92, help="人物占帧高比例，默认 0.92")
    parser.add_argument("--tol", type=int, default=26, help="抠图色差阈值，默认 26")
    parser.add_argument("--colors", type=int, default=0, help="压色板颜色数，0 表示关闭")
    parser.add_argument("--keep-corner", action="store_true", help="保留右下角内容（默认会清掉 AI 水印区）")
    args = parser.parse_args()

    log: list[str] = []
    views: dict[str, Image.Image] = {"front": load_rgba(Path(args.front))}
    if args.back:
        views["back"] = load_rgba(Path(args.back))
    if args.side:
        views["side"] = load_rgba(Path(args.side))

    fw, fh = args.frame
    sheet = build_sheet(
        views, fw, fh, args.height_ratio, args.tol, args.colors, log, not args.keep_corner
    )
    validate(sheet, fw, fh, log)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print("\n".join(log))
    print(f"[完成] 行走图已保存：{out}")

    if args.preview:
        preview = make_preview(sheet, (fw, fh))
        preview_path = Path(args.preview)
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview.save(preview_path)
        print(f"[完成] 预览图已保存：{preview_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
