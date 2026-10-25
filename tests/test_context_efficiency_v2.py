"""Focused evidence and bounded preparation without extra model calls."""
import unittest
import json
from unittest.mock import patch
import test_modeling_recovery_v2 as recovery
from backend.vision.storage import packed
from backend.vision.model_tasks import planning_progress
from backend.vision import provider


class ContextEfficiencyTest(unittest.TestCase):
    setUp = recovery.ModelingRecoveryTest.setUp
    tearDown = recovery.ModelingRecoveryTest.tearDown
    source = recovery.ModelingRecoveryTest.source
    turn = recovery.ModelingRecoveryTest.turn
    compile = recovery.ModelingRecoveryTest.compile

    def test_script_history_is_references_instead_of_full_repeated_programs(self):
        script = 'result=u.create_box((0,0,0),1,2,3)\n' + '# repeated script history\n'*200
        turns = [self.turn('preview_build', {'digest':str(i)*64, 'script_execution':'not_executed'},
                          response=packed({'tool':'preview_build','arguments':{'script':script,'parameters':{'length':i}}})) for i in range(6)]
        compiled, meta = self.compile(turns)
        self.assertNotIn('repeated script history', packed(compiled))
        self.assertEqual(len(compiled['recent_tool_groups']), 6)
        self.assertIn('script_reference', compiled['recent_tool_groups'][-1]['instruction']['arguments'])
        self.assertLess(meta['characters'], 9000)
        self.assertEqual(compiled['latest_build_preview']['turn_id'], turns[-1]['id'])

    def test_old_topology_is_summary_but_latest_requested_evidence_is_kept(self):
        old = self.turn('list_topology', {'entries':[{'id':'old-face','detail':'old-topology-detail'*200}], 'total_matches':1})
        latest = self.turn('inspect_geometry', {'metrics':[{'id':'current-face','area_mm2':12.5}]})
        compiled, _ = self.compile([old, latest])
        self.assertNotIn('old-topology-detail', packed(compiled))
        self.assertIn('12.5', packed(compiled['latest_observation']))
        self.assertEqual(compiled['recent_tool_groups'][0]['expand']['turn_id'], old['id'])

    def test_full_api_pages_prioritize_the_failed_operation(self):
        api = self.turn('native_api', {'entries':[{'symbol':'usd_brep.'+name,'signature':name+'()', 'documentation':name+' docs'}
                                                for name in ['unrelated_a','unrelated_b','unrelated_c','unrelated_d','boolean_union']]})
        failure = self.turn('build_geometry', {}, state='failed', error='SmApiBooleanUnion failed',
                            arguments=packed({'script':'result=u.boolean_union(a,b)'}))
        compiled, _ = self.compile([api, failure])
        self.assertEqual(compiled['cad_api_reference'][0]['symbol'], 'usd_brep.boolean_union')
        self.assertEqual(len(compiled['cad_api_reference']), 4)

    def test_original_intent_survives_a_short_followup(self):
        with self.ws.db() as db:
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({'origin':'user_task_input',
                       'text':'建模带螺纹螺丝，常用参数即可', 'conversation':True,'task_id':self.task['id'],'epoch':1}), self.task['source']))
        self.task['source'] = self.source('继续', conversation=True, task_id=self.task['id'], epoch=2)
        compiled, meta = self.compile()
        self.assertEqual(compiled['task_focus']['original_user_request']['text'], '建模带螺纹螺丝，常用参数即可')
        self.assertEqual(compiled['statement'], '继续')
        self.assertIn(compiled['task_focus']['original_user_request']['source_id'], meta['source_ids'])

    def test_preparation_is_bounded_even_with_new_queries_and_unlimited_mode(self):
        turns = [self.turn('native_api', {'runtime_id':'installed','entries':[{'symbol':'u.f'+str(i),'signature':'f()'}]}) for i in range(8)]
        progress = planning_progress(self.task, turns, 'installed')
        self.assertTrue(progress['recovery_required'])
        self.assertIn('native_api', progress['blocked_tools'])
        turns.append(self.turn('build_geometry', {'job':{'state':'succeeded'}}))
        self.assertEqual(planning_progress(self.task, turns, 'installed')['preparation_steps_since_execution'], 0)

    def test_comment_changes_do_not_make_unlimited_previews_useful(self):
        turns = [self.turn('preview_build', {'digest':str(i)*64}, response=packed({'tool':'preview_build',
                 'arguments':{'script':'result = u.create_box((0,0,0),1,2,3)\n# comment '+str(i)}})) for i in range(3)]
        self.assertIn('preview_build', planning_progress(self.task, turns)['blocked_tools'])

    def test_saved_preview_narrows_tools_and_uses_low_reasoning_for_empty_build(self):
        compiled = {'revision_id':self.head,'epoch':2,'project':{'geometry':'a'*64,'modeling_requirements':[{}]},
                    'task_focus':{}, 'cad_api_signatures':[{'symbol':'u.create_box','signature':'create_box()'}],
                    'latest_build_preview':{'epoch':2,'revision_id':self.head}}
        request = provider.payload(compiled, 'deepseek-flash')
        self.assertEqual(request['reasoning_effort'], 'low')
        self.assertNotIn('native_api', {t['function']['name'] for t in request['tools']})
        self.assertIn('build_geometry', {t['function']['name'] for t in request['tools']})

    def test_successful_rebuild_marks_old_failure_as_historical(self):
        failed = self.turn('build_geometry', {}, state='failed', error='old boolean failure')
        built = self.turn('build_geometry', {'job':{'state':'succeeded'}})
        compiled, _ = self.compile([failed, built])
        self.assertFalse(compiled['latest_failure']['current'])
        self.assertEqual(compiled['latest_failure']['resolved_by_turn_id'], built['id'])
        self.assertEqual(compiled['task_focus']['last_build_state'], 'succeeded')

    def test_one_failed_script_stays_available_without_replaying_all_candidates(self):
        failed = self.turn('build_geometry', {}, state='failed', error='invalid geometry',
                           arguments=packed({'script':'result=u.create_box((0,0,0),1,2,3)\n# active-edit-input'}))
        lookup = self.turn('native_api', {'entries':[]})
        compiled, _ = self.compile([failed, lookup])
        self.assertIn('active-edit-input', compiled['working_script']['text'])
        self.assertEqual(packed(compiled).count('active-edit-input'), 1)


if __name__ == '__main__':
    unittest.main()
