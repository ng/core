"""Synthetic regressions for candidate uploads and explicit Watch label gaps."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


train = load('train_personal', 'scripts/train-personal-models.py')
models = load('personal', 'docs/research/sleep-stage-calibration/personal-models.py')


class CandidateTests(unittest.TestCase):
    def test_upload_routes_and_explicit_selection(self):
        for select, activate in [(False, False), (True, False), (False, True)]:
            with self.subTest(select=select, activate=activate), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'model.json'
                path.write_text('{"version":"test"}')
                calls = []

                def response(request, timeout):
                    calls.append((request.method, request.full_url, json.loads(request.data)))
                    return io.StringIO('{"id":7}')

                with patch.object(train.urllib.request, 'urlopen', side_effect=response), patch('sys.stdout', new_callable=io.StringIO) as output:
                    train.upload('pod', 'left', path, select=select, activate=activate)
                self.assertEqual(calls[0], ('POST', 'http://pod:3000/api/sleep-stages/models', {'side': 'left', 'model': {'version': 'test'}}))
                self.assertEqual(calls[1], ('POST', 'http://pod:3000/api/sleep-stages/model/preview', {'side': 'left', 'nights': 14, 'model': {'version': 'test'}}))
                self.assertIn('in-sample', output.getvalue())
                self.assertEqual(len(calls), 3 if select or activate else 2)
                if select or activate:
                    self.assertEqual(calls[2], ('PUT', 'http://pod:3000/api/sleep-stages/models/selected', {'side': 'left', 'id': 7, 'active': activate}))

    def test_failed_preview_never_selects(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'model.json'
            path.write_text('{}')
            with patch.object(train, 'request_json', side_effect=[{'id': 7}, RuntimeError('offline')]) as request:
                with self.assertRaises(RuntimeError):
                    train.upload('pod', 'left', path, activate=True)
                self.assertEqual(request.call_count, 2)

    def test_conflicting_flags_refused_before_any_work(self):
        for flag in ['--select', '--activate']:
            with patch('sys.argv', ['train', '--pod', 'pod', '--no-upload', flag]), patch.object(train, 'snapshot') as snapshot:
                with self.assertRaises(SystemExit) as error:
                    train.main()
                self.assertEqual(error.exception.code, 2)
                snapshot.assert_not_called()


class LabelTests(unittest.TestCase):
    def test_explicit_gap_not_bridged_by_same_stage(self):
        rows = [{'ts': t, 'watch_stage': stage} for t, stage in [(0, 'light'), (60, ''), (120, 'light'), (180, 'light')]]
        epochs = [{'start': mid - 150} for mid in [30, 60, 90, 120, 150, 210, 240]]
        self.assertEqual([e['start'] + 150 for e, _ in models.label(epochs, rows)], [30, 120, 150, 210])

    def test_missing_sample_still_bridges_and_stage_change_does_not(self):
        epochs = [{'start': -60}]
        self.assertEqual(len(models.label(epochs, [{'ts': 0, 'watch_stage': 'light'}, {'ts': 120, 'watch_stage': 'light'}])), 1)
        self.assertEqual(models.label(epochs, [{'ts': 0, 'watch_stage': 'light'}, {'ts': 120, 'watch_stage': 'deep'}]), [])
