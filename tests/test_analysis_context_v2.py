"""Offline CAE planner integration; no live LLM calls or solver evidence fabricated."""
import copy
import unittest
from unittest.mock import Mock, patch

from backend.vision.analysis_context import analysis_context
from backend.vision.task_memory import current_receipt, observation
from backend.vision.task_tools import execute, tool_schemas, AnalysisContext, analysis_receipt
import json
from backend.vision import provider


class AnalysisContextTest(unittest.TestCase):
    def setUp(self):
        self.artifact = 'a' * 64
        self.manifest = {'bodies': [
            {'id': 'body-0', 'name': 'base', 'kind': 'solid', 'faces': []},
            {'id': 'body-1', 'name': 'column', 'kind': 'solid',
             'bbox_mm': {'min': [-20, -20, 15], 'max': [20, 20, 230]},
             'volume_mm3': 270176, 'area_mm2': 29530,
             'faces': [{'id': f'body-1/face-{i}', 'area_mm2': 1256,
                        'bbox_mm': {'min': [-20, -20, z], 'max': [20, 20, z]}} for i, z in enumerate((15, 230))]},
        ]}
        self.study = {'body_ids': ['body-1'], 'body_artifact_id': self.artifact,
                      'supports': [{'id': 'fixed', 'region': {'type': 'cad-face', 'artifactId': self.artifact, 'faceIds': ['body-1/face-0']}}],
                      'loads': [{'id': 'force', 'region': {'type': 'cad-face', 'artifactId': self.artifact, 'faceIds': ['body-1/face-0']}}]}
        self.document = {'geometry': self.artifact, 'study': self.study}
        self.workspace = Mock()
        self.workspace.artifacts.manifest.return_value = self.manifest
        self.workspace.revision.return_value = {'document': self.document}

    def test_exact_scope_geometry_conflict_and_pagination_are_read_only(self):
        result = analysis_context(self.workspace, self.document, 'revision', limit=1)
        self.assertEqual(result['scope']['body_ids'], ['body-1'])
        self.assertEqual(result['bodies'][0]['bbox_mm']['max'][2], 230)
        self.assertEqual(result['faces'][0]['id'], 'body-1/face-0')
        self.assertEqual(result['next_face_offset'], 1)
        self.assertIn('same_fixed_and_loaded_face: force', result['warnings'])
        self.assertEqual(analysis_context(self.workspace, self.document, 'revision', offset=1)['faces'][0]['id'], 'body-1/face-1')
        original = copy.deepcopy(self.document)
        receipt = execute(self.workspace, None, {'project': 'project', 'revision': 'revision', 'id': 'task', 'epoch': 1},
                          'analysis_context', AnalysisContext().model_dump(exclude_none=True))
        self.assertEqual(receipt['artifact_id'], self.artifact)
        self.assertEqual(self.document, original)
        self.workspace.edit.assert_not_called()
        self.workspace.enqueue.assert_not_called()

    def test_planning_scope_does_not_silently_rewrite_saved_scope(self):
        result = analysis_context(self.workspace, self.document, 'revision', body_ids=['body-0'])
        self.assertEqual(result['scope']['origin'], 'requested_for_planning')
        self.assertTrue(any('outside_requested_scope' in item for item in result['warnings']))
        self.assertEqual(self.document['study']['body_ids'], ['body-1'])
        candidate = {**self.study, 'body_ids': None, 'body_artifact_id': None}
        context = analysis_context(self.workspace, self.document, 'revision', candidate=candidate)
        self.assertEqual(context['scope']['body_ids'], ['body-0', 'body-1'])
        self.assertEqual(context['scope']['origin'], 'ui_candidate')
        self.study['body_artifact_id'] = 'old'
        self.assertFalse(analysis_context(self.workspace, self.document, 'revision')['scope']['saved_scope_current'])
        with self.assertRaises(ValueError):
            analysis_context(self.workspace, self.document, 'revision', body_ids=['body-9'])

    def test_tool_availability_and_old_evidence_fencing(self):
        self.assertIn('analysis_context', {item['function']['name'] for item in tool_schemas()})
        compiled = {'revision_id': 'revision', 'epoch': 1, 'project': self.document}
        self.assertIn('analysis_context', {item['function']['name'] for item in provider.payload(compiled, 'deepseek-flash')['tools']})
        compiled['project'] = {'geometry': None}
        self.assertNotIn('analysis_context', {item['function']['name'] for item in provider.payload(compiled, 'deepseek-flash')['tools']})
        compiled['project'] = self.document
        compiled['latest_analysis'] = {'current_revision': True, 'epoch': 1, 'job': {'state': 'succeeded'}}
        self.assertNotIn('solve', {item['function']['name'] for item in provider.payload(compiled, 'deepseek-flash')['tools']})
        compiled['latest_analysis']['current_revision'] = False
        self.assertIn('solve', {item['function']['name'] for item in provider.payload(compiled, 'deepseek-flash')['tools']})
        receipt = analysis_context(self.workspace, self.document, 'revision')
        stale = current_receipt({}, {'revision_id': 'changed', 'document': self.document}, 'analysis_context', receipt)
        self.assertEqual(stale['context_status'], 'stale_analysis_context')

    def test_duplicate_success_reuses_evidence_and_excludes_display_coordinates(self):
        job = {'id': 'existing', 'kind': 'fea', 'state': 'succeeded', 'revision': 'revision',
               'result': {'artifact_id': self.artifact, 'summary': {'maxDisplacement': .00617, 'relativeResidual': 1e-10,
                   'boundaries': [{'id': 'force', 'kind': 'load', 'force': [50, 0, 0], 'displayNodes': [[1, 2, 3]] * 5000}]}}}
        self.workspace.job.return_value = job
        task = {'project': 'project', 'revision': 'revision', 'id': 'task', 'epoch': 1, 'config': '{"mode":"deepseek/1"}'}
        with patch('backend.vision.task_tools.assess', return_value={'evidence_job_id': 'existing'}):
            reused = execute(self.workspace, None, task, 'solve', {})
        self.assertTrue(reused['reused'])
        self.assertNotIn('job_id', reused)
        self.workspace.enqueue.assert_not_called()
        self.assertNotIn('displayNodes', json.dumps(reused))
        self.assertLess(len(json.dumps(reused)), 2500)
        obs = observation({'id': 'turn', 'revision': 'revision', 'epoch': 1, 'state': 'succeeded', 'response': '{"tool":"solve"}'}, analysis_receipt(job))
        self.assertFalse(obs['truncated'])
        self.assertEqual(obs['receipt']['job']['result']['summary']['maxDisplacement'], .00617)
        with patch('backend.vision.task_tools.assess', return_value={'evidence_job_id': None}):
            execute(self.workspace, None, task, 'solve', {})
        self.workspace.enqueue.assert_called_once()

    def test_complete_setup_routes_directly_to_analysis_configuration(self):
        compiled = {'revision_id': 'revision', 'epoch': 1, 'project': self.document,
                    'analysis_setup': {**analysis_context(self.workspace, self.document, 'revision'), 'epoch': 1},
                    'planning_progress': {'recovery_required': True, 'blocked_tools': ['analysis_context']}}
        request = provider.payload(compiled, 'deepseek-flash')
        names = {item['function']['name'] for item in request['tools']}
        self.assertIn('configure_study', names)
        self.assertIn('ask_user', names)
        self.assertNotIn('analysis_context', names)
        self.assertNotIn('native_api', names)
        self.assertNotIn('build_geometry', names)
        self.assertNotIn('Query native_api for the specific missing signatures', request['messages'][0]['content'])
        compiled.pop('planning_progress')
        compiled['analysis_setup']['next_face_offset'] = 24
        self.assertIn('analysis_context', {item['function']['name'] for item in provider.payload(compiled, 'deepseek-flash')['tools']})
        compiled['analysis_setup'].update(next_face_offset=None, revision_id='old')
        self.assertIn('analysis_context', {item['function']['name'] for item in provider.payload(compiled, 'deepseek-flash')['tools']})


if __name__ == '__main__':
    unittest.main()
