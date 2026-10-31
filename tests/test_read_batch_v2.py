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
import test_model_tasks_v2 as model_fixtures


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


class ReadBatchRecoveryTest(unittest.TestCase):
    setUp = model_fixtures.ModelTaskTest.setUp
    tearDown = model_fixtures.ModelTaskTest.tearDown
    create = model_fixtures.ModelTaskTest.create

    def test_observed_3600_character_batch_is_rejected_then_repaired(self):
        task = self.create()
        source = self.tasks.get(task)['source']
        bad = model_fixtures.response('read_batch', {'calls': [
            {'tool': 'read_script', 'arguments': {'offset': 3800, 'limit': 3600}}]}, 'bad-range')
        good = model_fixtures.response('read_batch', {'calls': [
            {'tool': 'read_source', 'arguments': {'source_id': source, 'limit': 2000}}]}, 'fixed-range')
        actual_payload = provider.payload
        def payload(compiled, model):
            return actual_payload({**compiled, 'project': {**compiled['project'], 'geometry': 'a' * 64}}, model)

        with patch('backend.vision.provider.payload', side_effect=payload), \
             patch('backend.vision.provider.complete', side_effect=[bad, good]):
            with patch('backend.vision.tasks.execute') as execute:
                self.tasks.step(task)
                execute.assert_not_called()
            value = self.tasks.get(task)
            self.assertEqual(value['state'], 'executing')
            self.assertEqual(value['steps'][0]['state'], 'rejected')
            self.assertIn('2000', value['steps'][0]['error'])
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value['steps'][1]['state'], 'succeeded')
        self.assertEqual(value['steps'][1]['receipt']['calls'][0]['state'], 'succeeded')
        self.assertEqual(value['current_epoch_reported_tokens'], 30)
        self.assertEqual(value['config']['used_tokens'], 30)

    def test_repeated_bad_range_pauses_after_bounded_repair(self):
        task = self.create()
        bad = lambda key: model_fixtures.response('read_batch', {'calls': [
            {'tool': 'read_source', 'arguments': {'source_id': self.tasks.get(task)['source'], 'limit': 3600}}]}, key)
        with patch('backend.vision.provider.complete', side_effect=[bad('bad-1'), bad('bad-2')]) as complete:
            self.tasks.step(task)
            self.tasks.step(task)
            self.tasks.step(task)
        self.assertEqual(complete.call_count, 2)
        self.assertEqual(self.tasks.get(task)['state'], 'waiting_user')

    def test_epoch_tokens_are_distinct_from_conversation_total(self):
        from backend.vision import conversation
        sent = conversation.send(self.tasks, self.project, fixtures.command('first-message', expected_head=self.head,
            expected_task=None, expected_epoch=None, text='第一轮', artifact_id=None, selection=[]))
        task = sent['task_id']
        self.tasks.step(task)
        with patch('backend.vision.provider.complete', return_value=model_fixtures.response('finish', {'summary': '第一轮'}, 'epoch-1')):
            self.tasks.step(task)
        conversation.send(self.tasks, self.project, fixtures.command('next-message', expected_head=self.head,
            expected_task=task, expected_epoch=1, text='第二轮', artifact_id=None, selection=[]))
        self.tasks.step(task)
        with patch('backend.vision.provider.complete', return_value=model_fixtures.response('finish', {'summary': '第二轮'}, 'epoch-2')):
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value['epoch'], 2)
        self.assertEqual(value['current_epoch_reported_tokens'], 15)
        self.assertEqual(value['config']['used_tokens'], 30)
