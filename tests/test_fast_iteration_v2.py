"""Fast orchestration keeps validation while avoiding script regeneration."""
import unittest
import tempfile
from pathlib import Path
from backend.vision import provider
from backend.vision.contracts import SetModelingRequirements
from backend.vision.task_tools import prepare, CadScriptError
from backend.vision.native import run_cad
import test_modeling_recovery_v2 as fixtures


class FastIterationTest(unittest.TestCase):
    setUp = fixtures.ModelingRecoveryTest.setUp
    tearDown = fixtures.ModelingRecoveryTest.tearDown
    source = fixtures.ModelingRecoveryTest.source

    def test_complex_component_plan_requires_ordered_dependencies(self):
        args = fixtures.command(expected_head=self.head,
            requirements=[{'name':'assembly','metric':'manual','source_ids':[self.task['source']]}],
            components=[{'name':'base'},{'name':'shaft','depends_on':['base']},{'name':'cap','depends_on':['shaft']}])
        self.assertEqual(len(SetModelingRequirements.model_validate(args).components), 3)
        args['components'].reverse()
        with self.assertRaises(ValueError):
            SetModelingRequirements.model_validate(args)

    def test_component_plan_is_persisted_and_not_erased_by_requirement_updates(self):
        from backend.vision.modeling import set_requirements
        goals = [{'name':'assembly','metric':'manual','source_ids':[self.task['source']]}]
        first = set_requirements(self.ws,self.project,fixtures.command(expected_head=self.head,requirements=goals,
                                 components=[{'name':'base'},{'name':'pin','depends_on':['base']}]))
        second = set_requirements(self.ws,self.project,fixtures.command(expected_head=first['revision_id'],requirements=goals))
        self.assertEqual(first['revision_id'],second['revision_id'])
        self.assertEqual(self.ws.revision(self.project)['document']['modeling_plan'][1]['depends_on'], ['base'])

    def test_simple_generation_is_fast_and_complex_planning_gets_one_high_step(self):
        compiled = {'revision_id':self.head,'epoch':2,'project':{'geometry':None,'modeling_requirements':[{}]},
                    'cad_api_signatures':[{'symbol':'u.create_box','signature':'create_box()'}], 'task_focus':{}}
        self.assertEqual(provider.payload(compiled,'deepseek-flash')['reasoning_effort'], 'low')
        compiled['project']['modeling_plan'] = [{'name':str(i)} for i in range(4)]
        compiled['latest_observation'] = {'tool':'set_modeling_requirements'}
        self.assertEqual(provider.payload(compiled,'deepseek-flash')['reasoning_effort'], 'high')
        compiled['latest_observation'] = {'tool':'native_api'}
        self.assertEqual(provider.payload(compiled,'deepseek-flash')['reasoning_effort'], 'low')

    def test_parameter_only_preview_cannot_invent_geometry(self):
        with self.assertRaises(CadScriptError):
            prepare(self.task, {'tool':'preview_build','arguments':{'parameters':{'length':8}}}, [], self.ws)

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(), 'requires native CAD runtime')
    def test_named_components_are_reused_and_assembled_without_fusing(self):
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            root = Path(folder)
            first, second = root / 'first', root / 'second'
            first.mkdir(); second.mkdir()
            initial = run_cad({'script':'result={"base":u.create_box((0,0,0),10,10,2),"pin":u.create_cylinder((0,0,0),1,4)}',
                               'options':{}}, first)
            assembled = run_cad({'script':'u.translate(parts["pin"],(5,5,2))\nresult=parts',
                                'source_breps':[str(first/'body-0.brep'),str(first/'body-1.brep')],
                                'options':{'source_names':['base','pin']}}, second)
            self.assertEqual([b['name'] for b in assembled['bodies']], ['base','pin'])
            self.assertEqual(len(assembled['bodies']), 2)
            self.assertAlmostEqual(assembled['bodies'][0]['volume_mm3'], initial['bodies'][0]['volume_mm3'], places=4)
            self.assertAlmostEqual(assembled['bodies'][1]['bbox_mm']['min'][2], 2, places=3)


if __name__ == '__main__':
    unittest.main()
