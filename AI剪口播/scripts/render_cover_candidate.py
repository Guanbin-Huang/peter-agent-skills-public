#!/usr/bin/env python3
"""Render one full-resolution talking-head cover candidate from an A-roll PNG."""

from __future__ import annotations

import argparse
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFilter, ImageFont


# Keep durable brand, job, and domain phrases intact when a title wraps. This
# glossary complements the generic no-orphan rule below; explicit newlines still
# take priority when the editor has already chosen semantic line boundaries.
PROTECTED_PHRASES = tuple(sorted({
    "想科技创业", "具身智能行业", "具身智能", "人工智能", "算法工程师",
    "产品经理", "职业晋升", "线下共创空间", "生活大爆炸", "天坑专业",
    "非科班", "双非", "大模型", "机器人", "太爽了", "酥神", "WAIC", "To B", "To C",
}, key=len, reverse=True))


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--style", choices=("translucent-title-panel", "smiley-bold"), required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--subtitle", default="")
    return parser.parse_args()


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, stroke: int = 0) -> int:
    box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    return box[2] - box[0]


def semantic_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    index = 0
    while index < len(text):
        phrase = next((item for item in PROTECTED_PHRASES if text.startswith(item, index)), None)
        if phrase:
            tokens.append(phrase)
            index += len(phrase)
            continue
        latin = re.match(r"[A-Za-z0-9][A-Za-z0-9.+#_-]*", text[index:])
        if latin:
            tokens.append(latin.group(0))
            index += len(latin.group(0))
            continue
        tokens.append(text[index])
        index += 1
    return tokens


def rebalance_orphan(lines: list[str]) -> list[str]:
    if len(lines) < 2 or len(lines[-1].strip()) != 1:
        return lines
    previous = semantic_tokens(lines[-2])
    if len(previous) < 2:
        return lines
    moved = previous.pop()
    remaining = "".join(previous).rstrip()
    if not remaining:
        return lines
    return [*lines[:-2], remaining, moved.lstrip() + lines[-1].lstrip()]


def wrap_chars(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int, stroke: int = 0) -> list[str]:
    lines: list[str] = []
    for paragraph in (text or "").splitlines() or [""]:
        current = ""
        for token in semantic_tokens(paragraph.strip()):
            trial = current + token
            if current and text_width(draw, trial, font, stroke) > width:
                lines.append(current.rstrip())
                current = token.lstrip()
            else:
                current = trial
        if current:
            lines.append(current.rstrip())
    return rebalance_orphan(lines) or [""]


def fit_text(draw: ImageDraw.ImageDraw, text: str, font_path: str, max_width: int,
             max_lines: int, start_size: int, min_size: int, stroke_ratio: float = 0) -> tuple[ImageFont.FreeTypeFont, list[str], int]:
    for size in range(start_size, min_size - 1, -2):
        font = ImageFont.truetype(font_path, size)
        stroke = max(0, round(size * stroke_ratio))
        lines = wrap_chars(draw, text, font, max_width, stroke)
        if len(lines) <= max_lines:
            return font, lines, stroke
    font = ImageFont.truetype(font_path, min_size)
    stroke = max(0, round(min_size * stroke_ratio))
    return font, wrap_chars(draw, text, font, max_width, stroke)[:max_lines], stroke


def centered_x(draw: ImageDraw.ImageDraw, line: str, font: ImageFont.FreeTypeFont, width: int, stroke: int = 0) -> int:
    box = draw.textbbox((0, 0), line, font=font, stroke_width=stroke)
    return round((width - (box[2] - box[0])) / 2 - box[0])


def render_panel(image: Image.Image, font_path: str, title: str, subtitle: str) -> Image.Image:
    base = image.convert("RGBA")
    w, h = base.size
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    title_font, title_lines, _ = fit_text(draw, title, font_path, round(w * .88), 3, round(h * .105), round(h * .045))
    subtitle_font, subtitle_lines, _ = fit_text(draw, subtitle, font_path, round(w * .86), 2, round(h * .055), round(h * .03)) if subtitle else (None, [], 0)
    title_spacing = round(title_font.size * .16)
    subtitle_spacing = round((subtitle_font.size if subtitle_font else title_font.size) * .12)
    title_heights = [draw.textbbox((0, 0), line, font=title_font)[3] for line in title_lines]
    title_height = sum(title_heights) + title_spacing * max(0, len(title_lines) - 1)
    subtitle_heights = [draw.textbbox((0, 0), line, font=subtitle_font)[3] for line in subtitle_lines]
    subtitle_height = sum(subtitle_heights) + subtitle_spacing * max(0, len(subtitle_lines) - 1)
    gap = round(h * .022) if subtitle_lines else 0
    padding = round(h * .035)
    block_height = title_height + subtitle_height + gap + padding * 2
    # Peter's cover layout: the translucent title panel belongs in the lower-middle
    # zone, leaving the upper half available for the action/face silhouette.
    top = round(h * .67 - block_height / 2)
    draw.rectangle((0, top, w, top + block_height), fill=(0, 0, 0, 158))
    y = top + padding
    for index, line in enumerate(title_lines):
        draw.text((centered_x(draw, line, title_font, w), y), line, font=title_font, fill=(255, 255, 255, 255))
        y += title_heights[index] + title_spacing
    if subtitle_lines:
        y += gap - title_spacing
        for index, line in enumerate(subtitle_lines):
            draw.text((centered_x(draw, line, subtitle_font, w), y), line, font=subtitle_font, fill=(255, 159, 28, 255))
            y += subtitle_heights[index] + subtitle_spacing
    return Image.alpha_composite(base, overlay).convert("RGB")


def render_smiley(image: Image.Image, font_path: str, title: str, subtitle: str) -> Image.Image:
    base = image.convert("RGBA")
    w, h = base.size
    measurement = ImageDraw.Draw(base)
    title_font, title_lines, title_stroke = fit_text(
        measurement, title, font_path, round(w * .90), 2,
        round(h * .105), round(h * .055), .018,
    )
    subtitle_font, subtitle_lines, subtitle_stroke = fit_text(
        measurement, subtitle, font_path, round(w * .90), 2,
        round(h * .066), round(h * .042), .018,
    ) if subtitle else (None, [], 0)
    title_spacing = round(title_font.size * .06)
    subtitle_spacing = round((subtitle_font.size if subtitle_font else title_font.size) * .08)
    title_heights = [measurement.textbbox((0, 0), line, font=title_font, stroke_width=title_stroke)[3] for line in title_lines]
    subtitle_heights = [measurement.textbbox((0, 0), line, font=subtitle_font, stroke_width=subtitle_stroke)[3] for line in subtitle_lines]
    block_gap = round(h * .03) if subtitle_lines else 0
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    # Keep the no-panel title in the upper-middle zone. Main title and subtitle
    # are deliberately separate visual blocks, not one continuously wrapped text.
    y = round(h * .17)
    for font, lines, stroke, heights, spacing in (
        (title_font, title_lines, title_stroke, title_heights, title_spacing),
        (subtitle_font, subtitle_lines, subtitle_stroke, subtitle_heights, subtitle_spacing),
    ):
        if not lines:
            continue
        offset = max(4, round(font.size * .045))
        for index, line in enumerate(lines):
            x = centered_x(shadow_draw, line, font, w, stroke)
            shadow_draw.text((x + offset, y + offset), line, font=font, fill=(0, 0, 0, 190), stroke_width=stroke, stroke_fill=(0, 0, 0, 210))
            y += heights[index] + spacing
        if font is title_font and subtitle_lines:
            y += block_gap - title_spacing
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, round(title_font.size * .018))))
    composed = Image.alpha_composite(base, shadow)
    draw = ImageDraw.Draw(composed)
    y = round(h * .17)
    for font, lines, stroke, heights, spacing, color in (
        (title_font, title_lines, title_stroke, title_heights, title_spacing, (255, 255, 255, 255)),
        (subtitle_font, subtitle_lines, subtitle_stroke, subtitle_heights, subtitle_spacing, (255, 159, 28, 255)),
    ):
        if not lines:
            continue
        for index, line in enumerate(lines):
            x = centered_x(draw, line, font, w, stroke)
            draw.text((x, y), line, font=font, fill=color, stroke_width=stroke, stroke_fill=(28, 28, 28, 230))
            y += heights[index] + spacing
        if font is title_font and subtitle_lines:
            y += block_gap - title_spacing
    return composed.convert("RGB")


def main() -> None:
    options = args()
    source = Image.open(options.input)
    output = render_panel(source, options.font, options.title, options.subtitle) if options.style == "translucent-title-panel" else render_smiley(source, options.font, options.title, options.subtitle)
    target = Path(options.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    output.save(target, "PNG", optimize=True)


if __name__ == "__main__":
    main()
