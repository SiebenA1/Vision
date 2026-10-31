"""Persistent bounded reads preserve partial results without opening a write path."""
import json
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision import provider
from backend.vision.storage import packed
from backend.vision.task_tools import execute, prepare
from backend.vision.tool_admission import ToolAdmission
import test_tasks_v2 as fixtures


class ReadBatchTest(unittest.TestCase):
    setUp = fixtures.TaskProtocolTest.setUp
    tearDown = fixtures.TaskProtocolTest.tearDown
    create = fixtures.TaskProtocolTest.create
    advance = fixtures.TaskProtocolTest.advance

    def batch(self, calls):
        task = self.create([{'tool': 'read_batch', 'arguments': {'calls': calls}}])
        return task, self.advance(task)

    def test_ordered_results_and_failure_are_saved_and_exported(self):
        seed = self.create([{'tool': 'assessment', 'arguments': {}}], statement='原始来源', key='seed')
        source = self.tasks.get(seed)['source']
        task, value = self.batch([
            {'tool': 'read_source', 'arguments': {'source_id': source}},
            {'tool': 'read_source', 'arguments': {'source_id': 'f' * 32}}])
        receipt = value['steps'][0]['receipt']
        self.assertEqual(value['state'], 'completed')
        self.assertEqual([c['state'] for c in receipt['calls']], ['succeeded', 'failed'])
        self.assertEqual(receipt['calls'][0]['receipt']['text'], '原始来源')
        self.assertNotEqual(receipt['calls'][0]['call_id'], receipt['calls'][1]['call_id'])
        saved, _ = self.tasks.snapshot(task)
        expanded = execute(self.workspace, None, saved, 'read_tool_result',
                           {'turn_id': value['steps'][0]['id'], 'offset': 0, 'limit': 8000})
        self.assertIn('原始来源', expanded['text'])
        bundle = self.client.get(self.base + '/export').content
        with tempfile.TemporaryDirectory() as folder, TestClient(create_app(folder, run_jobs=False)) as client:
            restored = client.post('/api/v2/imports/bundle', headers={'X-Command-ID': 'import', 'Idempotency-Key': 'import'}, content=bundle)
            self.assertEqual(restored.status_code, 201, restored.text)
            imported = client.get(f'/api/v2/tasks/{task}').json()
            self.assertEqual(imported['steps'][0]['receipt'], receipt)
        self.tasks.forget(self.project, fixtures.command('forget', source_id=source))
        self.assertEqual(self.tasks.get(task)['steps'][0]['state'], 'redacted')

    def test_mixed_write_or_invalid_late_child_runs_nothing(self):
        snapshot = {'id': 'task', 'project': self.project, 'revision': self.head, 'epoch': 1, 'turns': 0}
        for calls in ([{'tool': 'read_source', 'arguments': {'source_id': 'f' * 32}},
                       {'tool': 'solve', 'arguments': {}}],
                      [{'tool': 'read_source', 'arguments': {'source_id': 'f' * 32}},
                       {'tool': 'read_source', 'arguments': {'source_id': 'not valid'}}]):
            with patch('backend.vision.task_tools.execute') as run:
                with self.assertRaises(ValueError):
                    prepare(snapshot, {'tool': 'read_batch', 'arguments': {'calls': calls}}, [], self.workspace)
                run.assert_not_called()

    def test_hidden_child_and_nested_batch_are_rejected_by_admission(self):
        compiled = {'revision_id': 'head', 'epoch': 1, 'workflow_phase': 'analysis',
                    'project': {'geometry': 'a' * 64}, 'recent_tool_groups': []}
        request = provider.payload(compiled, 'deepseek-flash')
        admission = ToolAdmission.capture(request['tools'])
        for child in ({'tool': 'read_script', 'arguments': {}}, {'tool': 'read_batch', 'arguments': {'calls': []}}):
            with self.assertRaises(ValueError):
                admission.validate_surface({'tool': 'read_batch', 'arguments': {'calls': [child]}})

    def test_interrupted_child_is_paused_and_not_replayed(self):
        task = self.create([{'tool': 'read_batch', 'arguments': {'calls': [
            {'tool': 'read_tool_result', 'arguments': {'turn_id': 'f' * 32}}]}}])
        self.tasks.step(task)

        def crash(*args):
            raise fixtures.ProcessCrash()

        original = execute
        def dispatch(workspace, queries, snapshot, tool, arguments):
            if tool == 'read_batch':
                return original(workspace, queries, snapshot, tool, arguments)
            return crash()

        with patch('backend.vision.task_tools.execute', side_effect=dispatch):
            with self.assertRaises(fixtures.ProcessCrash):
                self.tasks.step(task)
        with patch('backend.vision.task_tools.execute', side_effect=dispatch) as run:
            self.tasks.step(task)
            run.assert_not_called()  # Handler observes interrupted checkpoint first.
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'waiting_user')
        self.assertEqual(value['steps'][0]['receipt']['calls'][0]['state'], 'interrupted')

    def test_cancellation_between_children_never_starts_next_read(self):
        task = self.create([{'tool': 'read_batch', 'arguments': {'calls': [
            {'tool': 'read_source', 'arguments': {'source_id': 'a' * 32}},
            {'tool': 'read_source', 'arguments': {'source_id': 'b' * 32}}]}}])
        self.tasks.step(task)
        original = execute
        children = []
        def dispatch(workspace, queries, snapshot, tool, arguments):
            if tool == 'read_batch':
                return original(workspace, queries, snapshot, tool, arguments)
            children.append(tool)
            self.tasks.change(task, fixtures.command('cancel-batch', expected_epoch=1))
            return {'source_ids': [], 'text': 'late result'}
        with patch('backend.vision.task_tools.execute', side_effect=dispatch):
            self.tasks.step(task)
        self.assertEqual(children, ['read_source'])
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'cancelled')
        self.assertEqual([c['state'] for c in value['steps'][0]['receipt']['calls']],
                         ['cancelled', 'cancelled_before_start'])
