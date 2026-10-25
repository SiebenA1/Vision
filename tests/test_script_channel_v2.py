"""Bounded script edits and independent recovery for distinct response errors."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from backend.vision import provider
from backend.vision.model_tasks import repair_exhausted
from backend.vision.task_tools import prepare, execute, CadScriptError
from backend.vision.native import run_cad
from backend.vision.storage import packed
import test_modeling_recovery_v2 as fixtures


class ScriptChannelTest(unittest.TestCase):
    setUp = fixtures.ModelingRecoveryTest.setUp
    tearDown = fixtures.ModelingRecoveryTest.tearDown
    source = fixtures.ModelingRecoveryTest.source
    turn = fixtures.ModelingRecoveryTest.turn
    compile = fixtures.ModelingRecoveryTest.compile
    model = fixtures.ModelingRecoveryTest.model

    def test_different_protocol_errors_get_targeted_recovery_but_do_not_loop(self):
        rejected = self.turn('model_protocol_rejected', {}, state='rejected', response=packed({
            'tool':'model_protocol_rejected','provider':{'rejection_kind':'multiple_calls'}}))
        self.assertFalse(repair_exhausted(self.task,[rejected],'truncated_output'))
        self.assertTrue(repair_exhausted(self.task,[rejected],'multiple_calls'))
        truncated = self.turn('model_protocol_rejected', {}, state='rejected', response=packed({
            'tool':'model_protocol_rejected','provider':{'rejection_kind':'truncated_output'}}))
        self.assertTrue(repair_exhausted(self.task,[rejected,truncated],'arguments'))

    def test_multiple_calls_then_truncation_can_recover_without_executing_partial_tools(self):
        task = self.model()
        multiple = fixtures.response('finish',{'summary':'unused'},'one')
        multiple['choices'][0]['message']['tool_calls'].append(
            fixtures.response('ask_user',{'question':'unused'},'two')['choices'][0]['message']['tool_calls'][0])
        truncated = fixtures.response('finish',{'summary':'partial'},'three')
        truncated['choices'][0]['finish_reason']='length'
        with patch('backend.vision.provider.complete',side_effect=[multiple,truncated,fixtures.response('finish',{'summary':'未执行不完整调用'},'four')]) as complete, \
             patch('backend.vision.tasks.execute',wraps=execute) as run:
            self.tasks.step(task);self.tasks.step(task)
            self.assertEqual(self.tasks.get(task)['state'],'executing')
            run.assert_not_called()
            self.tasks.step(task)
        self.assertEqual(self.tasks.get(task)['state'],'completed')
        self.assertEqual(run.call_count,1)
        request=complete.call_args.args[0]
        self.assertIn('script_edits',request['messages'][0]['content'])
        self.assertEqual(request['reasoning_effort'],'low')
        self.assertEqual(request['max_tokens'],16384)

    def test_output_diagnostics_keep_counts_not_reasoning_text(self):
        value=fixtures.response('finish',{'summary':'partial'})
        value['choices'][0]['finish_reason']='length'
        value['choices'][0]['message']['reasoning_content']='private reasoning text'
        value['usage']['completion_tokens_details']={'reasoning_tokens':3}
        with self.assertRaises(provider.IncompleteToolResponse) as caught:
            provider.parse(value,'deepseek-flash')
        receipt=caught.exception.receipt
        self.assertEqual(receipt['rejection_kind'],'truncated_output')
        self.assertEqual(receipt['reasoning_tokens'],3)
        self.assertGreater(receipt['tool_argument_characters'],0)
        self.assertNotIn('private reasoning text',packed(receipt))

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(), 'requires CAD runtime')
    def test_exact_script_edit_reuses_source_and_validates_real_geometry(self):
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            root=Path(folder);first=root/'first';second=root/'second';first.mkdir();second.mkdir()
            script='result=u.create_box((0,0,0),parameters["length"],2,3)'
            result=run_cad({'script':script,'options':{'parameters':{'length':7}}},first)
            result.pop('stlBase64');result.pop('stlBytes')
            (first/'source.py').write_text(script,encoding='utf-8')
            manifest=self.ws.artifacts.publish(first,['source.py','body-0.brep','body-0.stl'],
                                               {**result,'kind':'cad','provenance':{'resolved_source':None}})
            changed=self.ws.edit(self.project,fixtures.command(expected_head=self.head),lambda db,doc:{**doc,'geometry':manifest['artifactId']})
            self.head=self.task['revision']=changed['revision_id']
            args={'base_script_sha256':manifest['files']['source.py'], 'script_edits':[{'old_text':',2,3)', 'new_text':',4,3)'}]}
            preview=prepare(self.task,{'tool':'preview_build','arguments':args},[],self.ws)
            self.assertNotIn('script_edits',preview)
            self.assertEqual(preview['replay_of'],manifest['artifactId'])
            self.assertFalse(preview['use_current'])
            edited=run_cad({'script':preview['script'],'options':{'parameters':{'length':7}}},second)
            self.assertAlmostEqual(edited['metrics']['volume_mm3'],84,places=3)
            for target in ('not present','r'):
                with self.assertRaises(CadScriptError):
                    prepare(self.task,{'tool':'preview_build','arguments':{'base_script_sha256':manifest['files']['source.py'],
                             'script_edits':[{'old_text':target,'new_text':'x'}]}},[],self.ws)
            with self.assertRaises(CadScriptError):
                prepare(self.task,{'tool':'preview_build','arguments':{**args,'base_script_sha256':'0'*64}},[],self.ws)
            self.assertEqual(self.ws.artifacts.file(manifest['artifactId'],'source.py').read_text(encoding='utf-8'),script)


if __name__ == '__main__':
    unittest.main()
