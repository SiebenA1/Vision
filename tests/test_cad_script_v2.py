"""Reject the observed invalid box overload without rejecting supported calls."""
import unittest

from backend.vision.task_tools import CadScriptError, validate_box_calls, validate_boolean_reuse


class BoxSignatureTest(unittest.TestCase):
    def test_consumed_cutter_reuse_is_rejected_in_loop(self):
        with self.assertRaisesRegex(CadScriptError, '已消耗'):
            validate_boolean_reuse('for tool in tools:\n a=u.boolean_difference(a,tool)\n b=u.boolean_difference(b,tool)')

    def test_copy_and_replaced_workpiece_are_allowed(self):
        validate_boolean_reuse('for tool in tools:\n a=u.boolean_difference(a,tool.copy())\n b=u.boolean_difference(b,tool)')
        validate_boolean_reuse('a=u.boolean_difference(a,c)\na=u.boolean_difference(a,d)')

    def test_consuming_function_alias_is_checked(self):
        with self.assertRaises(CadScriptError):
            validate_boolean_reuse('cut=u.boolean_difference\na=cut(a,c)\nb=cut(b,c)')

    def test_invalid_corner_call_is_rejected(self):
        with self.assertRaisesRegex(CadScriptError, "不接受两个角点"):
            validate_box_calls('v = u.create_box((-1.5, 112, 0), (1.5, 168, 14))')

    def test_installed_positional_and_keyword_signatures(self):
        validate_box_calls('v = u.create_box((-1.5,112,0),3,56,14)')
        validate_box_calls('v = u.create_box(origin=(-1.5,112,0),length=3,width=56,height=14)')

    def test_alias_and_duplicate_arguments(self):
        with self.assertRaises(CadScriptError):
            validate_box_calls('import usd_brep as cad\nv = cad.create_box(a,b)')
        with self.assertRaises(CadScriptError):
            validate_box_calls('v = u.create_box(a,3,56,14,height=14)')

    def test_dynamic_and_unrelated_calls_are_left_to_runtime(self):
        validate_box_calls('v = u.create_box(*args, **kwargs)')
        validate_box_calls('v = other.create_box(a,b)')


if __name__ == '__main__':
    unittest.main()
