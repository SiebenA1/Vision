"""Preflight state survives context trimming and cannot approve another script."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.vision.contracts import Build
from backend.vision.storage import Workspace, packed
from backend.vision.task_memory import context
from backend.vision.task_tools import prepare, CadScriptError
from backend.vision.provider import payload


class PreviewContextTest(unittest.TestCase):
    def setUp(self):
        self.task = {'id': 'task', 'epoch': 1, 'turns': 2, 'revision': 'a'*32}
        self.script = '# ' + 'large script comment ' * 800 + '\nresult=u.create_box((0,0,0),1,2,3)'
        self.saved = Build(command_id='preview', idempotency_key='preview', expected_head=self.task['revision'], script=self.script).model_dump()
        self.turn = {'id': 'preview-turn', 'epoch': 1, 'revision': self.task['revision'], 'state': 'succeeded',
                     'response': packed({'tool': 'preview_build', 'arguments': {'script': self.script}}),
                     'arguments': packed(self.saved), 'receipt': packed({'digest': 'b'*64})}

    def test_changed_input_is_rejected_before_attaching_old_digest(self):
        with self.assertRaisesRegex(CadScriptError, '最近预览不同'):
            prepare(self.task, {'tool': 'build_geometry', 'arguments': {'script': 'result=u.create_box((0,0,0),2,2,3)',
                    'expected_impact_digest': 'b'*64}}, [self.turn])

    def test_empty_build_uses_exact_saved_preview(self):
        build = prepare(self.task, {'tool': 'build_geometry', 'arguments': {}}, [self.turn])
        self.assertEqual(build['script'], self.script)
        self.assertEqual(build['expected_impact_digest'], 'b'*64)
        self.assertNotEqual(build['command_id'], self.saved['command_id'])

    def test_preview_state_survives_compacted_large_tool_group(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            workspace = Workspace(folder)
            revision = workspace.create({'command_id': 'new', 'idempotency_key': 'new', 'name': 'fixture'})
            self.task.update(project=revision['project_id'], revision=revision['revision_id'], source='user-source')
            self.turn['revision'] = revision['revision_id']
            with workspace.db() as db:
                db.execute('INSERT INTO sources VALUES(?,?,?,?)', ('user-source', revision['project_id'],
                           packed({'origin': 'user_task_input', 'text': '修改模型'}), 1))
            with patch('backend.vision.retrieval.retrieve', return_value=([], {})):
                compiled, metadata = context(workspace, self.task, [self.turn], budget=6000)
            self.assertNotIn(self.script, packed(compiled))
            reference = compiled['recent_tool_groups'][0]['instruction']['arguments']['script_reference']
            self.assertEqual(reference['characters'], len(self.script))
            self.assertEqual(reference['turn_id'], self.turn['id'])
            self.assertEqual(compiled['latest_build_preview']['digest'], 'b'*64)
            compiled['cad_api_signatures'] = [{'symbol': 'usd_brep.create_box'}]
            compiled['project']['modeling_requirements'] = [{'name':'fixture', 'metric':'solid_count', 'minimum':1, 'source_ids':['user-source']}]
            tool = next(t['function'] for t in payload(compiled, 'deepseek-flash')['tools'] if t['function']['name']=='build_geometry')
            self.assertEqual(tool['parameters']['properties'], {})


if __name__ == '__main__':
    unittest.main()
