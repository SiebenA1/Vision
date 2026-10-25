"""Real installed native worker regression for injected parameter names."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / '.python312/python.exe'


@unittest.skipUnless(PYTHON.is_file(), 'requires project-local native CAD runtime')
class NativeParametersTest(unittest.TestCase):
    def build(self, script, parameters):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as folder:
            folder = Path(folder)
            request, response = folder / 'request.json', folder / 'response.json'
            request.write_text(json.dumps({'script': script, 'options': {'parameters': parameters}}), encoding='utf-8')
            process = subprocess.run([str(PYTHON), '-I', '-X', 'utf8', str(ROOT / 'server/usd_brep_worker.py'),
                                      str(request), str(response)], capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertTrue(response.exists(), process.stderr)
            result = json.loads(response.read_text(encoding='utf-8'))
            self.assertNotIn('error', result, result.get('trace', result.get('error')))
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(result['bodies'][0]['kind'], 'solid')
            return result

    def test_original_params_expression_uses_supplied_values(self):
        result = self.build('p = params or {}\nresult = u.create_box((0,0,0), p.get("length",1),2,3)', {'length': 7})
        self.assertAlmostEqual(result['metrics']['volume_mm3'], 42, places=3)

    def test_alias_and_canonical_name_share_one_dictionary(self):
        result = self.build('assert params is parameters\nparams["length"] = 8\n'
                            'result = u.create_box((0,0,0), parameters["length"],2,3)', {'length': 7})
        self.assertAlmostEqual(result['metrics']['volume_mm3'], 48, places=3)

    def test_reused_cutter_copy_produces_two_valid_solids(self):
        result = self.build('a=u.create_box((0,0,0),10,10,10)\n'
                            'b=u.create_box((0,0,20),10,10,10)\n'
                            'tool=u.create_cylinder((5,5,-1),1,32)\n'
                            'a=u.boolean_difference(a,tool.copy())\n'
                            'b=u.boolean_difference(b,tool)\nresult={"a":a,"b":b}', {})
        self.assertEqual(len(result['bodies']), 2)
        self.assertTrue(all(body['kind'] == 'solid' for body in result['bodies']))
        self.assertAlmostEqual(result['metrics']['volume_mm3'], 2000 - 20 * 3.141592653589793, places=2)


if __name__ == '__main__':
    unittest.main()
