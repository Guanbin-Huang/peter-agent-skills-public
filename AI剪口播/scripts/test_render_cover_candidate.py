#!/usr/bin/env python3
"""Focused visual contract tests for the two talking-head cover styles."""

from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw, ImageFont

from render_cover_candidate import render_panel, render_smiley, text_width, wrap_chars


class SmileyCoverTest(unittest.TestCase):
    def test_semantic_wrap_keeps_tai_shuang_le_together(self):
        font_path = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
        if not font_path.exists():
            self.skipTest('fixture font unavailable')
        image = Image.new('RGB', (1080, 1920), 'black')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(font_path), 80)
        text = '跟人脑交太爽了！'
        width = text_width(draw, '跟人脑交太', font)
        lines = wrap_chars(draw, text, font, width)
        self.assertEqual(lines, ['跟人脑交', '太爽了！'])
        self.assertFalse(any(line.endswith('太') for line in lines))

    def test_semantic_wrap_never_splits_sushen_or_leaves_one_character_orphan(self):
        font_path = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
        if not font_path.exists():
            self.skipTest('fixture font unavailable')
        image = Image.new('RGB', (1080, 1920), 'black')
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(font_path), 80)
        text = '成为具身智能行业的酥神'
        width = text_width(draw, '成为具身智能行业的酥', font)
        lines = wrap_chars(draw, text, font, width)
        self.assertEqual(lines[-1], '酥神')
        self.assertNotIn('酥', lines[:-1])
        orphan_lines = wrap_chars(draw, '甲乙丙丁戊己', font, text_width(draw, '甲乙丙丁戊', font))
        self.assertGreaterEqual(len(orphan_lines[-1]), 2)

    def test_main_and_subtitle_use_separate_colored_blocks_with_gap(self):
        font = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
        if not font.exists():
            self.skipTest('fixture font unavailable')
        image = Image.new('RGB', (540, 960), (18, 18, 18))
        rendered = render_smiley(image, str(font), '想科技创业第2天', '成为具身智能行业的酥神')
        pixels = rendered.load()
        white_rows, orange_rows = set(), set()
        for y in range(rendered.height):
            for x in range(rendered.width):
                red, green, blue = pixels[x, y]
                if red > 235 and green > 235 and blue > 235:
                    white_rows.add(y)
                if red > 235 and 115 < green < 190 and blue < 70:
                    orange_rows.add(y)
        self.assertTrue(white_rows, 'main title must contain white pixels')
        self.assertTrue(orange_rows, 'subtitle must contain orange pixels')
        self.assertLess(max(white_rows), min(orange_rows), 'main title must stay above subtitle')
        self.assertGreaterEqual(min(orange_rows) - max(white_rows), round(rendered.height * .02))

    def test_panel_uses_white_main_title_and_orange_subtitle(self):
        font = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
        if not font.exists():
            self.skipTest('fixture font unavailable')
        image = Image.new('RGB', (540, 960), (18, 18, 18))
        rendered = render_panel(image, str(font), '想科技创业第2天', '成为具身智能行业的酥神')
        pixels = rendered.load()
        white = orange = False
        for y in range(rendered.height):
            for x in range(rendered.width):
                red, green, blue = pixels[x, y]
                white |= red > 235 and green > 235 and blue > 235
                orange |= red > 235 and 115 < green < 190 and blue < 70
        self.assertTrue(white, 'panel main title must contain white pixels')
        self.assertTrue(orange, 'panel subtitle must contain orange pixels')


if __name__ == '__main__':
    unittest.main()
