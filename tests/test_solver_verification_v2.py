"""References, durable verification lifecycle, and opt-in production numerical checks."""
import copy
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision import verification
from backend.vision.benchmarks import acceptance
from backend.vision.task_tools import execute, tool_schemas

INPUTS = dict(kind='cantilever', length_mm=100., width_mm=20., height_mm=10., elastic_modulus_mpa=210000., force_n=100., density_kg_m3=7850.)


def command(key, **values):
    return dict(command_id=key, idempotency_key=key, **values)


def fixture(profile):
    cases = []
    for name, mesh, error in [('axial-direct', 4, .01), ('axial-patch', 4, 0), ('bending-4', 4, .5), ('bending-2', 2, .2), ('bending-1', 1, .06)]:
        bending = name.startswith('bending')
        inputs = {**INPUTS, 'kind': 'cantilever' if bending else 'axial'}
        ref = verification.beam_reference(inputs)['displacement_mm']
        cases.append(dict(id=name, mesh_mm=mesh, relative_error=error, computed_mm=ref*(1-error), reference_mm=ref, inputs=inputs,
            kind=inputs['kind'], converged=True, relative_residual=1e-12, equilibrium_error=1e-12, strain_energy_mj=.1,
            volume_mm3=20000., mass_kg=.157, applied_force_error=1e-15, algorithm='Direct', expected_algorithm='Direct',
            tolerance=1e-6 if name == 'axial-patch' else .08 if bending else .02, acceptance_case=name not in ('bending-4','bending-2'),
            affine_displacement_error=0, stress_error=0, energy_error=0, passed=error < (.08 if bending else .02)))
    return dict(schema='vision.solver-check/1', profile=profile, suite='standard', passed=True, cases=cases,
        same_grid=dict(identical_nodes=True, identical_surface=True, direct_algorithm='Direct', cg_algorithm='CG',
            relative_displacement_difference=1e-9, relative_stress_difference=1e-9, relative_energy_difference=1e-12, cg_residual=1e-9, passed=True))


class VerificationTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.store = self.app.state.workspace

    def tearDown(self):
        self.client.close()
        self.folder.cleanup()

    def test_analytic_units_and_validation(self):
        response = self.client.post('/api/v2/calculations/beam', json=INPUTS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertAlmostEqual(response.json()['displacement_mm'], 2/21)
        self.assertAlmostEqual(response.json()['stress_mpa'], 30.)
        self.assertAlmostEqual(response.json()['mass_kg'], .157)
        self.assertAlmostEqual(response.json()['strain_energy_mj'], 100/21)
        axial = self.client.post('/api/v2/calculations/beam', json={**INPUTS, 'kind':'axial'}).json()
        self.assertAlmostEqual(axial['displacement_mm'], 10000/42000000)
        self.assertAlmostEqual(axial['stress_mpa'], .5)
        short = self.client.post('/api/v2/calculations/beam', json={**INPUTS, 'length_mm':10}).json()
        self.assertTrue(short['warnings'])
        for change in ({'force_n':0}, {'elastic_modulus_mpa':0}, {'kind':'plate'}, {'width_mm':-1}, {'unexpected':1}):
            self.assertEqual(self.client.post('/api/v2/calculations/beam', json={**INPUTS, **change}).status_code, 422)

    def test_queue_idempotency_cancel_recovery_and_project_isolation(self):
        project = self.client.post('/api/v2/projects', json=command('project', name='Unchanged')).json()
        payload = command('verification', suite='standard')
        first = self.client.post('/api/v2/solver-checks', json=payload)
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(self.client.post('/api/v2/solver-checks', json=payload).json(), first.json())
        self.assertEqual(self.client.post('/api/v2/solver-checks', json=command('second')).status_code, 409)
        run = first.json()['run_id']
        self.assertEqual(self.client.post(f'/api/v2/solver-checks/{run}/cancel', json={}).json()['state'], 'cancelled')
        second = verification.create(self.store, command('third', suite='standard'))['run_id']
        self.assertEqual(verification.claim(self.store)['id'], second)
        self.assertEqual(verification.cancel(self.store, second)['state'], 'cancelling')
        verification.finish(self.store, second, 'cancelled')
        verification.create(self.store, command('fourth', suite='standard'))
        claimed = verification.claim(self.store)
        verification.recover(self.store)
        self.assertEqual(verification.get(self.store, claimed['id'])['state'], 'interrupted')
        self.assertEqual(self.client.get(f"/api/v2/projects/{project['project_id']}").json()['revision_id'], project['revision_id'])

    def test_conclusions_recomputed_and_stale_profile_detected(self):
        run = verification.create(self.store, command('run', suite='standard'))['run_id']
        claimed = verification.claim(self.store)
        profile = claimed['input']['execution']['profile']
        report = fixture(profile)
        self.assertTrue(acceptance(report))
        for mutate in (
            lambda value: value.update(passed=False),
            lambda value: value['cases'][0].update(tolerance=1),
            lambda value: value['cases'][0].update(relative_error=float('nan')),
            lambda value: value['cases'][0].update(relative_residual=-1),
            lambda value: value['cases'].pop(),
            lambda value: value['same_grid'].update(cg_residual=1),
        ):
            changed = copy.deepcopy(report)
            mutate(changed)
            with self.assertRaises(ValueError):
                verification.validate_report(changed, profile)
        verification.finish(self.store, run, 'succeeded', report)
        self.assertEqual(verification.latest_evidence(self.store)['report'], report)
        with self.store.db() as db:
            saved = json.loads(db.execute('SELECT input FROM verification_runs WHERE id=?', (run,)).fetchone()[0])
            saved['execution']['profile']['packages']['scipy'] = 'old'
            db.execute('UPDATE verification_runs SET input=? WHERE id=?', (json.dumps(saved), run))
        self.assertFalse(verification.get(self.store, run)['current_runtime'])
        self.assertIsNone(verification.latest_evidence(self.store)['report'])
        self.assertEqual(verification.list_runs(self.store)[0]['passed'], True)

    def test_llm_receipts_distinguish_reference_from_project_evidence(self):
        schemas = {tool['function']['name'] for tool in tool_schemas()}
        self.assertTrue({'beam_reference','solver_validation'} <= schemas)
        task = dict(project='unused', id='unused', epoch=1)
        ref = execute(self.store, None, task, 'beam_reference', INPUTS)
        self.assertIn('不是当前CAD', ref['meaning'])
        self.assertIsNone(execute(self.store, None, task, 'solver_validation', {})['report'])


@unittest.skipUnless(os.environ.get('VISION_TEST_NATIVE_CORE') == '1', 'opt-in production solver')
class NativeVerificationTest(unittest.TestCase):
    def test_real_standard_suite_through_controller_and_durable_report(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            app = create_app(folder)
            with TestClient(app) as client:
                project = client.post('/api/v2/projects', json=command('create', name='Isolation')).json()
                response = client.post('/api/v2/solver-checks', json=command('native', suite='standard'))
                self.assertEqual(response.status_code, 202, response.text)
                run = response.json()['run_id']
                deadline = time.monotonic() + 300
                while time.monotonic() < deadline:
                    result = client.get(f'/api/v2/solver-checks/{run}').json()
                    if result['state'] not in ('queued','running','cancelling'):
                        break
                    time.sleep(.5)
                self.assertEqual(result['state'], 'succeeded', result)
                self.assertTrue(result['result']['passed'], result['result'])
                self.assertEqual(client.get(f"/api/v2/projects/{project['project_id']}").json()['revision_id'], project['revision_id'])
                self.assertTrue((Path(folder)/'verification-runs'/run/'mesh.npz').is_file())
            with TestClient(create_app(folder, run_jobs=False)) as reopened:
                self.assertEqual(reopened.get(f'/api/v2/solver-checks/{run}').json()['result'], result['result'])


if __name__ == '__main__':
    unittest.main()
