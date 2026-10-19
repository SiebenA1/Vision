import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from fea_contract import validate_study


class StudyContractTest(unittest.TestCase):
    def setUp(self):
        self.material = {"E": 210000, "nu": 0.3, "rho": 7850, "yieldStrength": 235}
        self.supports = [{"face": "x-min", "enabled": True}]
        self.loads = [{"face": "x-max", "vector": [1, 2, -3], "magnitude": 100, "enabled": True}]

    def test_accepts_supported_study(self):
        self.assertEqual(validate_study(self.material, self.supports, self.loads, 2)[1], self.loads)

    def test_rejects_disabled_empty_duplicate_or_invalid_conditions(self):
        for loads in ([], [{**self.loads[0], "enabled": False}],                       [{**self.loads[0], "vector": [0, 0, 0]}],
                      [{**self.loads[0], "vector": [float("nan"), 0, 1]}],
                      [{**self.loads[0], "face": "arbitrary"}],
                      [{**self.loads[0], "region": {"type": "box", "min": [1, 0, 0], "max": [0, 0, 0]}}]):
            with self.subTest(loads=loads), self.assertRaises(ValueError):
                validate_study(self.material, self.supports, loads, 2)

    def test_accepts_multiple_loads_and_explicit_regions(self):
        supports, loads = validate_study(self.material, self.supports * 2,
            [self.loads[0], {**self.loads[0], "region": {"type": "sphere", "center": [0, 0, 0], "radius": 10}}], 2)
        self.assertEqual(len(supports), 2)
        self.assertEqual(len(loads), 2)

    def test_rejects_invalid_materials_and_mesh(self):
        for key, value in (("E", -1), ("nu", 0.5), ("rho", float("inf")), ("yieldStrength", True)):
            material = {**self.material, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_study(material, self.supports, self.loads, 2)
        with self.assertRaises(ValueError):
            validate_study(self.material, self.supports, self.loads, 0)


if __name__ == "__main__":
    unittest.main()
