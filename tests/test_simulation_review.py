"""Real FEM evidence used by the first simulation UI batch."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
from engineering_server import _box_stl_base64
import fea_solver
import numpy as np


class SimulationReviewTest(unittest.TestCase):
    def test_actual_regions_and_extreme_offsets(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as directory, patch.object(fea_solver, 'WORK_ROOT', Path(directory)):
            result = fea_solver._solve_impl(_box_stl_base64(),
                {'E': 210000, 'nu': .3, 'rho': 7850, 'yieldStrength': 235},
                [{'id': 'base', 'face': 'x-min'}],
                [{'id': 'force', 'face': 'x-max', 'vector': [1, 0, 0], 'magnitude': 100}], 4)
        support, load = result['boundaries']
        self.assertEqual([support['id'], load['id']], ['base', 'force'])
        for region in (support, load):
            self.assertGreater(region['nodes'], 0)
            self.assertGreater(region['facets'], 0)
            self.assertAlmostEqual(region['areaMm2'], 200, places=5)
            self.assertLessEqual(len(region['displayNodes']), 192)
            self.assertTrue(np.isfinite(region['center']).all())
        np.testing.assert_allclose(load['force'], [100, 0, 0])
        points = np.asarray(result['positions']).reshape(-1, 3)
        displacement = np.asarray(result['displacement']).reshape(-1, 3)
        for metric in ('maxDisplacement', 'maxVonMises'):
            node = np.linalg.norm(points - result[metric + 'Location'], axis=1).argmin()
            np.testing.assert_allclose(result[metric + 'Displacement'], displacement[node], rtol=1e-6, atol=1e-10)


if __name__ == '__main__':
    unittest.main()
