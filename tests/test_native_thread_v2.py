"""Exercise actual installed CAD compositions; no remote model calls."""
import math
import unittest
import test_cad_parameters_v2 as native_tests


class ThreadCompositionTest(unittest.TestCase):
    build = native_tests.NativeParametersTest.build

    def nut(self, cutter):
        return self.build('import math\n'
            'profile=u.create_regular_polygon((0,0,0),sides=6,radius=17/math.sqrt(3))\n'
            'body=u.linear_sweep(profile,(0,0,1),8)\n'
            'body=u.boolean_difference(body,u.create_cylinder((0,0,-1),4.25,10))\n'
            'path=u.create_helix((0,0,-1),10,4.5,4.5,10/1.5,tolerance=0.001)\n'
            + cutter + '\nresult=u.boolean_difference(body,cutter)', {})

    def assert_cut(self, result):
        plain_volume = (math.sqrt(3)/2 * 17**2 - math.pi*4.25**2)*8
        self.assertEqual(len(result['bodies']), 1)
        self.assertLess(result['metrics']['volume_mm3'], plain_volume - 10)
        self.assertGreater(result['metrics']['volume_mm3'], plain_volume * .8)

    def test_option_b_round_thread_sweep_cuts_a_single_nut_solid(self):
        self.assert_cut(self.nut('cutter=u.pipe_sweep(path,radius=0.45)'))

    def test_finite_segments_form_triangle_and_helical_cutter(self):
        self.assert_cut(self.nut(
            'points=[(4.0,0,-1.35),(4.0,0,-0.65),(4.85,0,-1)]\n'
            'edges=[u.create_line_segment(points[i],points[(i+1)%3]) for i in range(3)]\n'
            'cutter=u.curve_sweep(edges,path,cap_ends=True)'))


if __name__ == '__main__':
    unittest.main()
