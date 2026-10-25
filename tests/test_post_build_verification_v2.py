"""Useful body measurements and bounded verification after a CAD result."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from backend.vision import provider
from backend.vision.modeling import geometry_summary
from backend.vision.model_tasks import planning_progress
from backend.vision.native import run_cad
from backend.vision.storage import packed
import test_modeling_recovery_v2 as fixtures


class PostBuildVerificationTest(unittest.TestCase):
    setUp = fixtures.ModelingRecoveryTest.setUp
    tearDown = fixtures.ModelingRecoveryTest.tearDown
    source = fixtures.ModelingRecoveryTest.source
    turn = fixtures.ModelingRecoveryTest.turn

    def compiled(self, status='needs_review', count=0):
        return {'revision_id':self.head,'epoch':2,'project':{'geometry':'a'*64,'modeling_requirements':[{}]},
                'task_focus':{'last_build_state':'succeeded'}, 'model_completion_state':{'status':status},
                'planning_progress':{'post_build_inspections':count},
                'cad_api_signatures':[{'symbol':'usd_brep.create_box','signature':'create_box()'}]}

    def test_checked_result_closes_after_two_inspections_but_failures_allow_repair(self):
        for status in ('needs_review','checks_passed'):
            request = provider.payload(self.compiled(status,2),'deepseek-flash')
            names = {item['function']['name'] for item in request['tools']}
            self.assertNotIn('list_topology',names)
            self.assertNotIn('inspect_geometry',names)
            self.assertIn('finish',names)
            self.assertIn('preview_build',names)
        names = {item['function']['name'] for item in provider.payload(self.compiled('failed',2),'deepseek-flash')['tools']}
        self.assertIn('inspect_geometry',names)

    def test_inspection_budget_resets_after_a_new_build(self):
        turns = [self.turn('build_geometry',{})] + [self.turn('list_topology',{}) for _ in range(2)]
        self.assertEqual(planning_progress(self.task,turns)['post_build_inspections'],2)
        turns.append(self.turn('build_geometry',{}))
        self.assertEqual(planning_progress(self.task,turns)['post_build_inspections'],0)

    def test_independent_measurement_calls_merge_without_executing_writes(self):
        response = fixtures.response('inspect_geometry',{'selection':['body-0']},'one')
        response['choices'][0]['message']['tool_calls'].append(
            fixtures.response('inspect_geometry',{'selection':['body-1']},'two')['choices'][0]['message']['tool_calls'][0])
        item, receipt = provider.parse(response,'deepseek-flash')
        self.assertEqual(item['arguments']['selection'],['body-0','body-1'])
        self.assertEqual(receipt['call_ids'],['one','two'])
        response['choices'][0]['message']['tool_calls'][1]['function']['name']='build_geometry'
        with self.assertRaises(provider.MultipleToolCalls):
            provider.parse(response,'deepseek-flash')

    def test_summary_stays_bounded_and_does_not_claim_feature_verification(self):
        body = {'id':'body-0','name':'large'*200,'kind':'solid','bbox_mm':{'min':[0,0,0],'max':[1,1,1]},'faces':[],'edges':[]}
        summary = geometry_summary({'bodies':[body]*20},budget=600)
        self.assertLess(len(packed(summary)),700)
        self.assertTrue(summary['bodies_truncated'])
        self.assertIn('not proof',summary['scope'])

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(), 'requires CAD runtime')
    def test_real_body_metrics_and_pair_gap_need_no_topology_pagination(self):
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            root=Path(folder)
            result=run_cad({'script':'result={"base":u.create_box((0,0,0),10,10,2),"lid":u.create_box((0,0,7),10,10,1)}','options':{}},root)
            result.pop('stlBase64');result.pop('stlBytes')
            manifest=self.ws.artifacts.publish(root,['body-0.brep','body-0.stl','body-1.brep','body-1.stl'],{**result,'kind':'cad'})
            changed=self.ws.edit(self.project,fixtures.command(expected_head=self.head),lambda db,doc:{**doc,'geometry':manifest['artifactId']})
            request={'revision_id':changed['revision_id'],'artifact_id':manifest['artifactId'],'selection':['body-0','body-1'],'metrics_only':True}
            with patch.object(self.app.state.queries,'run',side_effect=AssertionError('cached body inspection must not spawn a worker')):
                measured=self.app.state.queries.inspect(self.project,request)
            self.assertEqual(len(measured['metrics']),2)
            self.assertAlmostEqual(measured['metrics'][0]['volume_mm3'],200,places=3)
            summary=geometry_summary(manifest)
            self.assertAlmostEqual(summary['bbox_relation']['axis_gaps_mm']['z'],5,places=3)
            native=self.app.state.queries.run({'source_breps':[str(self.ws.artifacts.file(manifest['artifactId'],'body-0.brep'))],
                                               'selection':['body-0'],'metrics_only':True})
            self.assertAlmostEqual(native['metrics'][0]['volume_mm3'],200,places=3)
            self.assertEqual(native['visual']['lines'],[])


if __name__ == '__main__':
    unittest.main()
