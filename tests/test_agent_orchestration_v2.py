"""Regression for the observed B-choice preview failure and capability loss."""
import json
import unittest
from unittest.mock import patch
import test_modeling_recovery_v2 as recovery
from backend.vision import provider
from backend.vision.model_tasks import planning_progress
from backend.vision.storage import packed


class AgentOrchestrationTest(unittest.TestCase):
    setUp = recovery.ModelingRecoveryTest.setUp
    tearDown = recovery.ModelingRecoveryTest.tearDown
    source = recovery.ModelingRecoveryTest.source
    compile = recovery.ModelingRecoveryTest.compile
    turn = recovery.ModelingRecoveryTest.turn
    model = recovery.ModelingRecoveryTest.model

    def compiled(self, **extra):
        return dict(revision_id=self.head, epoch=2,
                    project={'geometry':'a'*64, 'modeling_requirements':[{'name':'nut'}]},
                    cad_capability_index={'core_signatures':[{'symbol':'usd_brep.create_line_segment',
                        'signature':'create_line_segment(start,end) -> Curve'}]}, **extra)

    def tools(self, compiled):
        return {v['function']['name']:v['function'] for v in provider.payload(compiled, 'deepseek-flash')['tools']}

    def test_recovery_offers_preview_before_existing_geometry_build(self):
        compiled = self.compiled(planning_progress={'recovery_required':True, 'blocked_tools':['native_api']})
        tools = self.tools(compiled)
        self.assertIn('preview_build', tools)
        self.assertNotIn('build_geometry', tools)
        compiled['latest_build_preview'] = {'epoch':2, 'revision_id':self.head}
        self.assertEqual(self.tools(compiled)['build_geometry']['parameters']['properties'], {})
        compiled['latest_build_preview']['epoch'] = 1
        self.assertNotIn('build_geometry', self.tools(compiled))

    def test_module_failure_recovery_keeps_exact_code_repair_tools(self):
        compiled=self.compiled(planning_progress={'recovery_required':True,'blocked_tools':['search_code_modules']},
            latest_failure={'tool':'build_geometry','current':True},
            task_focus={'module_assembly_reference':{'artifact_id':'a'*64},'failed_modules':[{'component_id':'body'}]})
        tools=self.tools(compiled)
        self.assertTrue({'read_code_module','patch_code_module','read_code_assembly','preview_build'} <= set(tools))
        self.assertNotIn('search_code_modules',tools)
        self.assertNotIn('read_script',tools)

    def test_reasoning_and_workflow_share_one_system_instruction(self):
        request = provider.payload(self.compiled(), 'deepseek-flash')
        self.assertEqual(request['thinking'], {'type':'enabled'})
        self.assertEqual(request['tool_choice'], 'auto')
        self.assertEqual(request['reasoning_effort'], 'low')
        self.assertEqual([m['role'] for m in request['messages']], ['system','user'])
        self.assertIn('next construction action is preview_build', request['messages'][0]['content'])
        self.assertGreaterEqual(request['max_tokens'], 16384)

    def test_runtime_capabilities_survive_context_trimming_and_expire_on_update(self):
        turn = self.turn('native_api', {'runtime_id':'installed', 'entries':[],
                         'capability_index':self.compiled()['cad_capability_index']}, epoch=1)
        with patch('backend.vision.queries.api_identity', return_value='installed'):
            compiled, _ = self.compile([turn], budget=10000)
        self.assertEqual(compiled['cad_capability_index']['core_signatures'][0]['symbol'], 'usd_brep.create_line_segment')
        self.assertLessEqual(len(packed(compiled)), 10000)
        with patch('backend.vision.queries.api_identity', return_value='updated'):
            compiled, _ = self.compile([turn])
        self.assertIsNone(compiled['cad_capability_index'])
        self.assertFalse(provider.has_cad_reference(compiled))

    def test_prior_epoch_known_signatures_do_not_reset_lookup_progress(self):
        receipt = {'runtime_id':'installed', 'entries':[{'symbol':'usd_brep.create_line_segment', 'signature':'(start,end)'}]}
        turns = [self.turn('native_api', receipt, epoch=1)]
        turns += [self.turn('native_api', receipt) for _ in range(3)]
        self.assertTrue(planning_progress(self.task, turns, 'installed')['recovery_required'])
        self.assertFalse(planning_progress(self.task, turns, 'updated')['recovery_required'])

    def test_invalid_build_is_repaired_without_counting_a_phantom_job(self):
        task = self.model()
        responses = [recovery.response('build_geometry', {'script':'result=None'}, 'bad-build'),
                     recovery.response('finish', {'summary':'尚未构建'}, 'honest')]
        with patch('backend.vision.provider.complete', side_effect=responses), patch('backend.vision.tasks.execute') as run:
            self.tasks.step(task)
            self.assertEqual(self.tasks.get(task)['jobs'], 0)
            self.assertEqual(self.tasks.get(task)['steps'][-1]['state'], 'rejected')
            run.assert_not_called()
        with patch('backend.vision.provider.complete', return_value=responses[-1]):
            self.tasks.step(task)
        self.assertEqual(self.tasks.get(task)['state'], 'completed')
        self.assertEqual(self.tasks.get(task)['jobs'], 0)


if __name__ == '__main__':
    unittest.main()
