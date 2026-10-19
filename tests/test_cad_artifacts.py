import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import cad_artifacts

class CadArtifactTest(unittest.TestCase):
    def test_publish_archive_and_path_boundary(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as root:
            source = Path(root) / "build"
            source.mkdir()
            (source / "model.usda").write_bytes(b"#usda 1.0")
            (source / "preview.stl").write_bytes(b"preview")
            (source / "body-0.stl").write_bytes(b"body")
            with patch.object(cad_artifacts, "ROOT", Path(root) / "artifacts"):
                first = cad_artifacts.publish(source, {"bodies": []})
                second = cad_artifacts.publish(source, {"bodies": []})
                identity = first["artifactId"]
                self.assertEqual(identity, second["artifactId"])
                self.assertEqual(cad_artifacts.read_file(identity, "body-0.stl"), b"body")
                self.assertEqual(cad_artifacts.import_archive(cad_artifacts.archive(identity)), b"#usda 1.0")
                with self.assertRaises(ValueError): cad_artifacts.read_file("../outside", "model.usda")
                with self.assertRaises(ValueError): cad_artifacts.read_file(identity, "../request.json")

if __name__ == "__main__": unittest.main()
