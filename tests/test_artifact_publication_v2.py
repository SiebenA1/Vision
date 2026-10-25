"""Manifest-last publication when Windows denies directory renames."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.vision.storage import Artifacts, Missing


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'data.bin').write_bytes(b'complete native geometry')
        self.artifacts = Artifacts(self.root / 'artifacts')

    def test_denied_rename_publishes_complete_artifact_and_reuses_it(self):
        with patch('backend.vision.storage.os.rename', side_effect=PermissionError(5, 'Access denied')):
            manifest = self.artifacts.publish(self.source, ['data.bin'], {'kind': 'cad'})
            self.assertEqual(self.artifacts.file(manifest['artifactId'], 'data.bin').read_bytes(), b'complete native geometry')
            self.assertEqual(self.artifacts.publish(self.source, ['data.bin'], {'kind': 'cad'}), manifest)

    def test_manifest_is_not_visible_when_file_publication_fails(self):
        with patch('backend.vision.storage.os.rename', side_effect=PermissionError(5, 'Access denied')), \
             patch('backend.vision.storage.shutil.copyfileobj', side_effect=PermissionError(5, 'Access denied')):
            with self.assertRaises(PermissionError):
                self.artifacts.publish(self.source, ['data.bin'], {'kind': 'cad'})
        targets = [p for p in self.artifacts.root.iterdir() if len(p.name) == 64]
        self.assertEqual(len(targets), 1)
        with self.assertRaises(Missing):
            self.artifacts.manifest(targets[0].name)

    def test_cleanup_denied_does_not_report_a_committed_artifact_as_failed(self):
        with patch('backend.vision.storage.os.rename', side_effect=PermissionError(5, 'Access denied')), \
             patch('backend.vision.storage.shutil.rmtree', side_effect=PermissionError(5, 'Access denied')):
            manifest = self.artifacts.publish(self.source, ['data.bin'], {'kind': 'cad'})
        self.assertEqual(self.artifacts.manifest(manifest['artifactId']), manifest)


if __name__ == '__main__':
    unittest.main()
