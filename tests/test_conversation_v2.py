"""Persistent conversation, context, cancellation fencing and unlimited execution."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision import provider
from test_model_tasks_v2 import response
from test_tasks_v2 import command


class ConversationTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.key = patch('backend.vision.provider.api_key', return_value='test-only-key')
        self.key.start()
        self.project = self.client.post('/api/v2/projects', json=command('project', name='Conversation')).json()
        self.path = '/api/v2/projects/' + self.project['project_id'] + '/conversation'

    def tearDown(self):
        self.key.stop()
        self.client.close()
        self.folder.cleanup()

    def send(self, name, text, **fields):
        current = self.client.get(self.path).json()['task']
        request = command(name, expected_head=self.project['revision_id'], text=text,
                          expected_task=current['id'] if current else None, expected_epoch=current['epoch'] if current else None, **fields)
        result = self.client.post(self.path, json=request)
        self.assertEqual(result.status_code, 202, result.text)
        return result.json(), request

    def reply(self, task, tool, arguments, call):
        self.app.state.tasks.step(task)
        with patch('backend.vision.provider.complete', return_value=response(tool, arguments, call)) as complete:
            self.app.state.tasks.step(task)
        return json.loads(complete.call_args.args[0]['messages'][1]['content'])

    def test_followup_restores_history_and_reuses_task_without_repeating_work(self):
        first, _ = self.send('first', '记住梁长100mm，请问我还缺什么。')
        self.reply(first['task_id'], 'ask_user', {'question': '材料是什么？'}, 'one')
        second, request = self.send('second', '钢材，E=210000MPa。先总结已知信息，不建模。')
        self.assertEqual(first['task_id'], second['task_id'])
        self.assertEqual(second['epoch'], 2)
        compiled = self.reply(second['task_id'], 'finish', {'summary': '梁长100mm，钢材E=210000MPa，尚未建模。'}, 'two')
        self.assertIn('梁长100mm', compiled['conversation_messages'][0]['text'])
        self.assertEqual(compiled['recent_tool_groups'][0]['tool_receipt']['question'], '材料是什么？')
        restored = TestClient(create_app(self.folder.name, run_jobs=False)).get(self.path).json()
        self.assertEqual([m['role'] for m in restored['messages']], ['user', 'assistant', 'user', 'assistant'])
        self.assertEqual(restored['task']['config']['used_tokens'], 30)
        self.assertTrue(restored['task']['config']['unlimited'])
        self.assertEqual(self.client.post(self.path, json=request).json(), second)
        self.assertEqual(len(self.client.get(self.path).json()['messages']), 4)

    def test_static_planner_reads_geometry_then_configures_and_submits_one_solve(self):
        workspace = self.app.state.workspace
        folder = Path(self.folder.name) / 'analysis-fixture'
        folder.mkdir()
        (folder / 'source.py').write_text('# offline artifact fixture, not verified CAD', encoding='utf-8')
        manifest = workspace.artifacts.publish(folder, ['source.py'], {'kind': 'cad', 'bodies': [
            {'id': 'body-0', 'name': 'beam', 'kind': 'solid', 'faces': [
                {'id': 'body-0/face-0', 'area_mm2': 200}, {'id': 'body-0/face-1', 'area_mm2': 200}], 'edges': []}]})
        self.project = workspace.edit(self.project['project_id'], command('fixture', expected_head=self.project['revision_id']),
                                      lambda db, document: {**document, 'geometry': manifest['artifactId']})
        request, _ = self.send('analysis', '允许按钢材示例，固定左端、右端横向100N，配置并计算。',
                               artifact_id=manifest['artifactId'], selection=['body-0'],
                               analysis_draft={'material': {'E': 210000, 'nu': .3, 'rho': 7850, 'yieldStrength': 235},
                                               'supports': [], 'loads': [], 'mesh_size': 4,
                                               'body_ids': ['body-0'], 'body_artifact_id': manifest['artifactId']})
        study = {'material': {'E': 210000, 'nu': .3, 'rho': 7850, 'yieldStrength': 235},
                 'supports': [{'id': 'fixed', 'region': {'type': 'cad-face', 'artifactId': manifest['artifactId'], 'faceIds': ['body-0/face-0'], 'toleranceMm': .1}}],
                 'loads': [{'id': 'load', 'vector': [0, 0, -1], 'magnitude': 100, 'region': {'type': 'cad-face', 'artifactId': manifest['artifactId'], 'faceIds': ['body-0/face-1'], 'toleranceMm': .1}}],
                 'mesh_size': 4, 'body_ids': ['body-0'], 'body_artifact_id': manifest['artifactId']}
        task = request['task_id']
        self.app.state.tasks.step(task)
        with patch('backend.vision.provider.complete', side_effect=[
                response('analysis_context', {'body_ids': ['body-0']}, 'analysis-context'),
                response('configure_study', {'study': study}, 'analysis-config'),
                response('solve', {}, 'analysis-solve')]):
            for _ in range(3):
                self.app.state.tasks.step(task)
        result = self.app.state.tasks.get(task)
        self.assertEqual(result['state'], 'waiting_job', result)
        self.assertEqual(result['jobs'], 1)
        receipt = result['steps'][0]['receipt']
        self.assertEqual(receipt['scope']['body_ids'], ['body-0'])
        self.assertEqual(receipt['candidate_study']['supports'], [])
        self.assertEqual(receipt['faces'][1]['id'], 'body-0/face-1')
        configured = workspace.revision(self.project['project_id'])['document']['study']
        self.assertEqual(configured['body_ids'], ['body-0'])
        self.assertEqual(configured['loads'][0]['magnitude'], 100)
        visible = self.client.get(self.path).json()['messages'][0]['text']
        self.assertEqual(visible, '允许按钢材示例，固定左端、右端横向100N，配置并计算。')

    def test_late_response_after_new_message_is_discarded(self):
        first, _ = self.send('first', '旧目标')
        self.app.state.tasks.step(first['task_id'])
        def change(request):
            self.send('second', '新目标：不要执行旧计划。')
            return response('finish', {'summary': '旧回复不得落入新轮次'}, 'old')
        with patch('backend.vision.provider.complete', side_effect=change):
            self.app.state.tasks.step(first['task_id'])
        value = self.client.get(self.path).json()
        self.assertEqual(value['task']['epoch'], 2)
        self.assertEqual(value['task']['state'], 'created')
        self.assertEqual([m['role'] for m in value['messages']], ['user', 'user'])

    def test_concurrent_message_and_invalid_reference_do_not_write(self):
        _, old = self.send('first', '第一条')
        stale = {**old, **command('stale'), 'text': '旧页面'}
        self.assertEqual(self.client.post(self.path, json=stale).status_code, 409)
        current = self.client.get(self.path).json()['task']
        invalid = command('invalid', expected_head=self.project['revision_id'], text='固定这里', expected_task=current['id'],
                          expected_epoch=current['epoch'], artifact_id='a'*64, selection=['body-0/face-0'])
        self.assertEqual(self.client.post(self.path, json=invalid).status_code, 409)
        self.assertEqual(len(self.client.get(self.path).json()['messages']), 1)

    def test_unlimited_ignores_aggregate_budgets_and_preserves_metering(self):
        first, _ = self.send('first', '只查询证据')
        task = first['task_id']
        self.app.state.tasks.step(task)
        with self.app.state.workspace.db() as db:
            config = json.loads(db.execute('SELECT config FROM agent_tasks WHERE id=?', (task,)).fetchone()[0])
            config.update(started_at=0, used_tokens=300000)
            db.execute('UPDATE agent_tasks SET config=?,turns=25,jobs=10 WHERE id=?', (json.dumps(config),task))
        with patch('backend.vision.provider.complete', return_value=response('finish', {'summary':'已完成'}, 'unlimited')):
            self.app.state.tasks.step(task)
        result = self.client.get(self.path).json()['task']
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(result['config']['used_tokens'], 300015)
        content = self.client.get('/api/v2/projects/'+self.project['project_id']+'/export').content
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder, run_jobs=False)) as client:
                restored = client.post('/api/v2/imports/bundle',content=content,headers={'X-Command-ID':'restore-long','Idempotency-Key':'restore-long'})
                self.assertEqual(restored.status_code,201,restored.text)

    def test_conversation_bundle_and_source_forgetting(self):
        first, _ = self.send('first', '需要保留的对话')
        self.reply(first['task_id'], 'finish', {'summary': '已经记录'}, 'one')
        content = self.client.get('/api/v2/projects/'+self.project['project_id']+'/export').content
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder, run_jobs=False)) as client:
                imported = client.post('/api/v2/imports/bundle', content=content, headers={'X-Command-ID':'import','Idempotency-Key':'import'})
                self.assertEqual(imported.status_code, 201, imported.text)
                self.assertEqual(len(client.get(self.path).json()['messages']), 2)
        source = self.client.get(self.path).json()['messages'][0]['id']
        self.client.post('/api/v2/projects/'+self.project['project_id']+'/sources/forget', json=command('forget',source_id=source))
        self.assertEqual(self.client.get(self.path).json()['messages'], [])


if __name__ == '__main__':
    unittest.main()
