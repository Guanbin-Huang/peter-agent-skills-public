import argparse
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import template_package as t


class TemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.style = t.resolve_style(t.DEFAULT_PRESET)

    def file(self, name, data):
        p = self.root / name
        p.write_text(data)
        return p

    def overrides(self, data):
        return t.resolve_style(t.DEFAULT_PRESET, self.file('overrides.json', json.dumps(data)))

    def test_default_preset_and_ass_equivalence(self):
        self.assertTrue(t.DEFAULT_PRESET.is_file())
        a = t.compile_ass(self.style, [(2, 3, 'hello\nworld')], 'Test')
        for value in ('Test,76,&H90000000', 'Test,76,&H00FFFFFF', r'\pos(543,1363)\blur3\shad0', r'\pos(540,1360)\blur0\shad0', r'hello\Nworld', '0:00:02.00,0:00:03.00'):
            self.assertIn(value, a)

    def test_overrides_and_resolved_rebuild(self):
        style = self.overrides({'captions': {'font_size': 64, 'y': 1200}})
        self.assertEqual(style['captions']['font_size'], 64)
        p = self.file('style.json', json.dumps(style))
        self.assertEqual(t.resolve_style(p), style)

    def test_shadow_overrides_preserve_sharp_foreground(self):
        cues = [(0, 1, 'embodied AI\n具身智能')]
        original = t.compile_ass(self.style, cues, 'Smiley Sans Oblique')
        original_foreground = [line for line in original.splitlines() if line.startswith(('Style: Foreground,', 'Dialogue: 1,'))]
        for field, value in [('shadow_opacity', 0.9), ('shadow_offset', 5), ('shadow_blur', 5)]:
            with self.subTest(field=field):
                style = self.overrides({'captions': {field: value}})
                ass = t.compile_ass(style, cues, 'Smiley Sans Oblique')
                self.assertNotEqual(ass, original)
                self.assertEqual([line for line in ass.splitlines() if line.startswith(('Style: Foreground,', 'Dialogue: 1,'))], original_foreground)
                self.assertIn(r'\blur0\shad0', ass)
                self.assertEqual(style['captions']['font_size'], self.style['captions']['font_size'])
                self.assertEqual(style['captions']['y'], self.style['captions']['y'])

    def test_unknown_and_invalid_numbers(self):
        for changes in ({'other': 1}, {'captions': {'unknown': 2}}, {'captions': {'font_size': float('nan')}}, {'captions': {'y': 1921}}, {'captions': {'x': True}}, {'protected_regions': [{'x': 1000, 'y': 0, 'width': 100, 'height': 10}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.overrides(changes)

    def test_font_family_cmap_and_two_line_guard(self):
        font = unittest.mock.Mock()
        font.getmetrics.return_value = (76, 20)
        font.getlength.return_value = 200
        with patch.object(t.ImageFont, 'truetype', return_value=font), patch.object(t, 'TTFont') as tt:
            metadata = tt.return_value.__enter__.return_value
            metadata['name'].getName.return_value.toUnicode.return_value = 'Smiley Sans Oblique'
            metadata.getBestCmap.return_value = {ord(ch): 'glyph' for ch in '中文hello'}
            self.assertEqual(t.layout_guard(self.style, [(0, 1, '中文')], 'font.ttf'), 'Smiley Sans Oblique')
            metadata['name'].getName.assert_any_call(1, 3, 1, 0x409)
            with self.assertRaisesRegex(ValueError, 'missing subtitle glyphs'):
                t.layout_guard(self.style, [(0, 1, '缺字')], 'font.ttf')
            with self.assertRaisesRegex(ValueError, 'at most two'):
                t.layout_guard(self.style, [(0, 1, 'hello\nhello\nhello')], 'font.ttf')
            metadata['name'].getName.return_value = None
            with self.assertRaisesRegex(ValueError, 'nameID1'):
                t.layout_guard(self.style, [(0, 1, '中文')], 'font.ttf')

    def test_srt(self):
        p = self.file('captions.srt', '1\n00:00:02,001 --> 00:00:03,009\nfirst\nsecond\n')
        self.assertEqual(t.parse_srt(p, 4)[0][2], 'first\nsecond')
        for body in ('1\n00:00:02,000 --> 00:00:01,000\ntext', '1\n00:00:00,000 --> 00:00:02,000\na\n\n2\n00:00:01,999 --> 00:00:03,000\nb', '1\n00:00:00,001 --> 00:00:00,004\na', '1\n00:00:00,000 --> 00:00:01,000\n{\\pos(1,2)}a'):
            with self.subTest(body=body), self.assertRaises(ValueError):
                t.parse_srt(self.file('bad.srt', body), 4)

    def test_layout_bounds_and_protected_regions(self):
        font = unittest.mock.Mock()
        font.getname.return_value = ('Family', 'Regular')
        font.getmetrics.return_value = (76, 20)
        font.getlength.return_value = 400
        with patch.object(t.ImageFont, 'truetype', return_value=font), patch.object(t, 'TTFont') as tt:
            metadata = tt.return_value.__enter__.return_value
            metadata['name'].getName.return_value.toUnicode.return_value = 'Family'
            metadata.getBestCmap.return_value = {n: 'glyph' for n in range(32, 127)}
            t.layout_guard(self.style, [(0, 1, 'hello')], 'font.ttf')
            bad = copy.deepcopy(self.style)
            bad['captions']['x'] = 10
            with self.assertRaises(ValueError):
                t.layout_guard(bad, [(0, 1, 'hello')], 'font.ttf')
            bad = copy.deepcopy(self.style)
            bad['protected_regions'] = [{'x': 400, 'y': 1300, 'width': 100, 'height': 100}]
            with self.assertRaises(ValueError):
                t.layout_guard(bad, [(0, 1, 'hello')], 'font.ttf')

    def test_stale_inputs_and_assets(self):
        originals = {name: self.file(name, name) for name in ('video', 'srt', 'font', 'style.json', 'captions.ass')}
        package = {'schema_version': 1, 'inputs': {k: t.record(originals[k]) for k in ('video', 'srt', 'font')}, 'assets': {k: t.record(originals[k]) for k in ('style.json', 'captions.ass')}}
        p = self.file('package.json', json.dumps(package))
        t.load_package(p, validate_frames=False)
        for name, path in originals.items():
            path.write_text('changed')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'stale'):
                t.load_package(p, validate_frames=False)
            path.write_text(name)

    def test_conflicts_fail_before_work(self):
        args = argparse.Namespace(output_dir=self.root)
        with self.assertRaisesRegex(ValueError, 'conflict'):
            t.build(args)
        with self.assertRaisesRegex(ValueError, 'conflict'):
            t.snapshot(args)
        output = self.file('final.mp4', 'existing')
        with self.assertRaisesRegex(ValueError, 'conflict'):
            t.render(argparse.Namespace(output=output))
        self.assertEqual(output.read_text(), 'existing')

    def test_build_rejects_input_and_configuration_edit_during_build(self):
        for edited in ('srt', 'preset', 'overrides', 'font', 'video'):
            files = {name: self.file(name, name) for name in ('video', 'srt', 'font')}
            files['srt'].write_text('1\n00:00:00,000 --> 00:00:01,000\nhello\n')
            files['preset'] = self.file('preset.json', json.dumps(self.style))
            files['overrides'] = self.file('overrides.json', '{}')
            out = self.root / ('package-' + edited)
            args = argparse.Namespace(**files, output_dir=out)
            real_parse = t.parse_srt
            def parsing(path, duration):
                cues = real_parse(path, duration)
                files[edited].write_text('changed during processing')
                return cues
            with self.subTest(edited=edited), patch.object(t, 'validate_video', return_value=({}, [0] * 60, 2)), patch.object(t, 'parse_srt', side_effect=parsing), patch.object(t, 'layout_guard', return_value='Test'), self.assertRaisesRegex(ValueError, 'changed during build'):
                t.build(args)
            self.assertFalse(out.exists())

    def test_multiple_audio_tracks_are_rejected(self):
        p = {'streams': [{'codec_type': 'video'}, {'codec_type': 'audio'}, {'codec_type': 'audio'}]}
        with patch.object(t, 'probe', return_value=p), self.assertRaisesRegex(ValueError, 'exactly one original audio'):
            t.validate_video('source')

    def test_directory_publication_failure_cleans_only_owned_files(self):
        temp = self.root / 'temporary'
        temp.mkdir()
        (temp / 'a').write_text('a')
        (temp / 'b').write_text('b')
        real_link = t.os.link
        for preserve_foreign in (False, True):
            destination = self.root / ('preserved' if preserve_foreign else 'cleaned')
            calls = []
            def linking(source, target):
                calls.append(target)
                if len(calls) == 2:
                    if preserve_foreign:
                        (destination / 'user.txt').write_text('keep')
                    raise OSError('publication failed')
                return real_link(source, target)
            with patch.object(t.os, 'link', side_effect=linking), self.assertRaisesRegex(OSError, 'publication failed'):
                t.publish_dir(temp, destination)
            if preserve_foreign:
                self.assertEqual(list(destination.iterdir()), [destination / 'user.txt'])
                self.assertEqual((destination / 'user.txt').read_text(), 'keep')
            else:
                self.assertFalse(destination.exists())

    def test_source_pts_guard_not_just_metadata(self):
        from fractions import Fraction
        p = {'streams': [{'codec_type': 'video', 'width': 1080, 'height': 1920,
                          'sample_aspect_ratio': '1:1', 'r_frame_rate': '30/1',
                          'avg_frame_rate': '30/1', 'color_transfer': 'bt709', 'color_space': 'bt709', 'color_primaries': 'bt709', 'time_base': '1/15360', 'start_time': '0'},
                         {'codec_type': 'audio', 'start_time': '0'}]}
        with patch.object(t, 'probe', return_value=p), patch.object(t, 'frame_pts', return_value=[Fraction(0), Fraction(1, 30), Fraction(2, 30)]):
            self.assertEqual(t.validate_video('source')[2], 0.1)
        with patch.object(t, 'probe', return_value=p), patch.object(t, 'frame_pts', return_value=[Fraction(0), Fraction(1, 30), Fraction(3, 30)]), self.assertRaisesRegex(ValueError, 'PTS guard'):
            t.validate_video('source')
        for change in ({'color_transfer': 'smpte2084'}, {'color_transfer': 'unknown'}, {'color_space': 'unknown'}, {'color_primaries': 'unknown'}, {'width': 1920}, {'tags': {'rotate': '90'}}, {'start_time': '0.1'}, {'avg_frame_rate': '30000/1001'}):
            invalid = copy.deepcopy(p)
            invalid['streams'][0].update(change)
            with self.subTest(change=change), patch.object(t, 'probe', return_value=invalid), self.assertRaises(ValueError):
                t.validate_video('source')

    def test_render_is_caption_only_audio_copy(self):
        package = {'probe': {'streams': [{'codec_type': 'video', 'time_base': '1/15360'}]}, 'inputs': {'video': {'path': 'video.mp4'}}, 'assets': {'captions.ass': {'path': '/tmp/captions.ass'}, 'fonts/font.ttf': {'path': '/tmp/fonts/font.ttf', 'sha256': 'h'}}}
        command = t.render_command(package, 'master', 'output.mp4')
        self.assertEqual(command[command.index('-c:a') + 1], 'copy')
        self.assertEqual(command[command.index('-crf') + 1], '18')
        joined = ' '.join(command)
        for forbidden in ('atempo', 'setpts', 'trim=', 'fps=', 'scale=', 'whisper', 'start_at_zero'):
            self.assertNotIn(forbidden, joined)
        self.assertIn('-copyts', command)
        preview = t.render_command(package, 'preview', 'preview.mp4')
        self.assertTrue(preview[preview.index('-vf') + 1].startswith('scale=540:960,setsar=1,subtitles='))

    def test_snapshot_nonzero_original_time_and_alignment(self):
        package = {'duration': 4, 'inputs': {'video': {'path': 'video.mp4'}}, 'assets': {'captions.ass': {'path': '/tmp/captions.ass'}, 'fonts/font.ttf': {'path': '/tmp/fonts/font.ttf', 'sha256': 'h'}}}
        for value in (-1, 4, 0.01, float('nan')):
            with patch.object(t, 'load_package', return_value=(package, None)), self.assertRaises(ValueError):
                t.snapshot(argparse.Namespace(package='package', at=[value], output_dir=self.root / 'out'))
        # Test the command separately from hashes/publication and assert -ss precedes -i.
        with patch.object(t, 'load_package', return_value=(package, None)), patch.object(t, 'run') as run, patch.object(t, 'sha', return_value='h'), patch.object(t, 'publish_dir'), patch.object(t.Image, 'open') as image_open:
            image_open.return_value.__enter__.return_value.size = (1080, 1920)
            package['inputs']['video']['sha256'] = 'h'
            package['assets']['captions.ass']['sha256'] = 'h'
            t.snapshot(argparse.Namespace(package='package', at=[2.0], output_dir=self.root / 'out'))
            cmd = run.call_args.args[0]
            self.assertEqual(cmd[cmd.index('-ss') + 1], '2.0')
            self.assertLess(cmd.index('-ss'), cmd.index('-i'))
            self.assertIn('-copyts', cmd)
            self.assertNotIn('-start_at_zero', cmd)


if __name__ == '__main__':
    unittest.main()
