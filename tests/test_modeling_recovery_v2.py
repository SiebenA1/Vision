"""Regression checks for context loss, stalled planning and memory invalidation.

All model calls are mocked; each test uses a fresh local workspace.
"""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.vision.api import create_app
from backend.vision import conversation, provider
from backend.vision.engineering_memory import entries, record
from backend.vision.model_tasks import planning_progress
from backend.vision.storage import identity, packed
from backend.vision.task_memory import context
from backend.vision.task_tools import execute, prepare, CadScriptError


def command(**fields):
    key = identity()
    return dict(command_id=key, idempotency_key=key, **fields)


def response(tool, arguments, call='offline-call'):
    if tool == 'finish':
        arguments = {'outcome':'answer', **arguments}
    return dict(id='offline-' + call, model='deepseek-flash',
                usage=dict(prompt_tokens=10, completion_tokens=5, total_tokens=15),
                choices=[dict(finish_reason='tool_calls', message=dict(tool_calls=[dict(id=call, type='function',
                function=dict(name=tool, arguments=packed(arguments)))]))])


class ModelingRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.ws, self.tasks = self.app.state.workspace, self.app.state.tasks
        rev = self.ws.create(command(name='recovery regression'))
        self.project, self.head = rev['project_id'], rev['revision_id']
        self.task = dict(id='fixture-task', epoch=2, revision=self.head, project=self.project, turns=1)
        self.task['source'] = self.source('继续建模', conversation=True, task_id=self.task['id'], epoch=2)
        self.semantic = patch.dict('os.environ', VISION_MEMORY_SEMANTIC='0')
        self.semantic.start()

    def tearDown(self):
        self.semantic.stop()
        self.app.state.queries.close()
        self.folder.cleanup()

    def source(self, text, **extra):
        key = identity()
        with self.ws.db() as db:
            db.execute('INSERT INTO sources VALUES(?,?,?,?)',
                       (key, self.project, packed(dict(origin='user_task_input', text=text, **extra)), time.time()))
        return key

    def turn(self, tool, receipt, **fields):
        return dict(dict(id=identity(), epoch=2, revision=self.head, state='succeeded',
                    response=packed(dict(tool=tool, arguments={})), receipt=packed(receipt)), **fields)

    def compile(self, turns=(), **kwargs):
        with patch('backend.vision.retrieval.retrieve', return_value=([], {})):
            return context(self.ws, self.task, list(turns), budget=kwargs.pop('budget', 24000), **kwargs)

    def memory(self, summary, sources, supersedes=(), scope='project'):
        return record(self.ws, self.project, command(expected_head=self.head, summary=summary, kind='requirement',
                      scope=scope, source_ids=sources, supersedes=list(supersedes)))['source_id']

    def model(self, statement='建立模型'):
        with patch('backend.vision.provider.api_key', return_value='offline-only'):
            task = self.tasks.create(self.project, command(expected_head=self.head, statement=statement,
                                     max_jobs=3, max_requests=12, unlimited=True), model=True)['task_id']
        self.tasks.step(task)
        return task

    def send(self, text, task=None):
        current = self.tasks.get(task) if task else None
        with patch('backend.vision.provider.api_key', return_value='offline-only'):
            return conversation.send(self.tasks, self.project, command(expected_head=self.head, text=text,
                                     expected_task=task, expected_epoch=current['epoch'] if current else None,
                                     selection=[], artifact_id=None))

    def test_latest_large_observation_is_pinned_and_expandable(self):
        turn = self.turn('read_script', dict(text='a' * 8000, offset=0, total_characters=8000))
        compiled, meta = self.compile([turn], budget=10000)
        latest = compiled['latest_observation']
        self.assertEqual(latest['turn_id'], turn['id'])
        self.assertTrue(latest['truncated'])
        self.assertEqual(latest['read_tool_result']['turn_id'], turn['id'])
        self.assertLessEqual(len(packed(compiled)), 10000)
        self.assertTrue(compiled['context_omissions']['recent_tool_groups'])

    def test_tool_layer_borrows_idle_capacity_without_exceeding_total_budget(self):
        turn = self.turn('read_script', dict(text='a' * 8000, offset=0, total_characters=8000))
        compiled, meta = self.compile([turn])
        self.assertEqual(compiled['recent_tool_groups'][-1]['turn_id'], turn['id'])
        self.assertGreater(meta['layers']['recent_tool_groups']['borrowed_characters'], 0)
        self.assertLessEqual(len(packed(compiled)), 24000)

    def test_current_selection_survives_long_message(self):
        ref = dict(artifact_id='a' * 64, revision_id=self.head, selection=['body-9/face-2'])
        self.task['source'] = self.source('修改所选面。' + '细节' * 2500, conversation=True,
                                        task_id=self.task['id'], epoch=2, reference=ref)
        compiled, _ = self.compile()
        self.assertEqual(compiled['current_reference']['selection'], ref['selection'])
        self.assertFalse(compiled['current_reference']['current_geometry'])

    def test_failed_turn_survives_followup_context(self):
        turn = self.turn('build_geometry', dict(job_id='job'), state='failed', error='script_error: invalid shape')
        compiled, _ = self.compile([turn])
        self.assertEqual(compiled['latest_failure']['turn_id'], turn['id'])
        self.assertIn('invalid shape', compiled['latest_failure']['error'])

    def test_superseded_ancestors_invalidate_derived_memory(self):
        old = self.memory('厚度3mm', [self.source('厚度3mm')])
        child = self.memory('按3mm计算间隙', [old])
        self.memory('厚度5mm', [self.source('改成5mm')], [old])
        values = {v['source_id']: v for v in entries(self.ws, self.project)}
        self.assertFalse(values[child]['applicable'])

    def test_stale_geometry_ancestor_invalidates_derived_memory(self):
        geometry = self.ws.edit(self.project, command(expected_head=self.head), lambda db, doc: {**doc, 'geometry':'a' * 64})
        self.head = geometry['revision_id']
        old = self.memory('该面保留3mm', [self.source('保留该面')], scope='geometry')
        child = self.memory('根据该面决定安装间隙', [old])
        self.ws.edit(self.project, command(expected_head=self.head), lambda db, doc: {**doc, 'geometry':'b' * 64})
        values = {v['source_id']: v for v in entries(self.ws, self.project)}
        self.assertFalse(values[child]['applicable'])

    def test_disabled_memory_is_removed_from_search_and_read_receipt_replay(self):
        memory = self.memory('厚度3mm', [self.source('厚度3mm')])
        with self.ws.db() as db:
            value = json.loads(db.execute('SELECT payload FROM sources WHERE id=?', (memory,)).fetchone()[0])
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({**value, 'status':'inactive'}), memory))
        for tool, receipt in [('search_sources', dict(sources=[dict(source_id=memory, text='厚度3mm')])),
                              ('read_source', dict(source_id=memory, source_ids=[memory], text='厚度3mm')),
                              ('read_tool_result', dict(turn_id='historical', source_ids=[memory], text='厚度3mm'))]:
            with self.subTest(tool=tool):
                compiled, _ = self.compile([self.turn(tool, receipt)])
                self.assertNotIn('厚度3mm', packed(compiled['recent_tool_groups']))
                self.assertNotIn('厚度3mm', packed(compiled['latest_observation']))

    def test_repeated_previews_stall_but_distinct_read_pages_do_not(self):
        previews = [self.turn('preview_build', dict(digest='a' * 64)) for _ in range(4)]
        progress = planning_progress(self.task, previews)
        self.assertTrue(progress['recovery_required'])
        self.assertIn('preview_build', progress['blocked_tools'])
        pages = [self.turn('read_script', dict(offset=i * 500, text=str(i)),
                          response=packed(dict(tool='read_script', arguments=dict(offset=i * 500)))) for i in range(12)]
        self.assertFalse(planning_progress(self.task, pages)['recovery_required'])

    def test_stalled_empty_queries_are_not_offered_or_executed_again(self):
        task = self.model()
        count = 0
        def complete(request):
            nonlocal count
            count += 1
            return response('native_api', dict(query='missing'), 'call-' + str(count))
        with patch('backend.vision.provider.complete', side_effect=complete), patch(
                'backend.vision.tasks.execute', return_value=dict(entries=[], total_matches=0)) as run:
            for _ in range(8):
                self.tasks.step(task)
        self.assertEqual(self.tasks.get(task)['state'], 'waiting_user')
        self.assertEqual(run.call_count, 3)
        self.assertEqual(count, 5)
        self.assertIn('空转', self.tasks.get(task)['error'])

    def test_stalled_preparation_can_still_expand_a_new_failure(self):
        compiled, _ = self.compile([self.turn('build_geometry', {}, state='failed', error='bad shape')])
        compiled['planning_progress'] = dict(recovery_required=True, blocked_tools=['native_api'])
        names = {tool['function']['name'] for tool in provider.payload(compiled, 'deepseek-flash')['tools']}
        self.assertIn('read_tool_result', names)
        self.assertNotIn('native_api', names)

    def test_short_reply_stays_bound_to_original_question_after_tools(self):
        task = self.send('请自行设计刹车盘')['task_id']
        self.tasks.step(task)
        with patch('backend.vision.provider.complete', return_value=response('ask_user', dict(question='按400mm、34mm多体方案执行？'))):
            self.tasks.step(task)
        self.send('是', task)
        snapshot, turns = self.tasks.snapshot(task)
        later = [dict(self.turn('read_script', dict(text='x' * 8000)), epoch=snapshot['epoch']) for _ in range(12)]
        with patch('backend.vision.retrieval.retrieve', return_value=([], {})):
            compiled, _ = context(self.ws, snapshot, turns + later, budget=24000)
        self.assertEqual(compiled['latest_user_reply']['question'], '按400mm、34mm多体方案执行？')
        self.assertEqual(compiled['latest_user_reply']['answer'], '是')

    def test_read_tool_result_is_project_scoped_and_paginated(self):
        task = self.model('读取历史回执')
        with patch('backend.vision.provider.complete', return_value=response('finish', dict(summary='已结束'))):
            self.tasks.step(task)
        snapshot, turns = self.tasks.snapshot(task)
        result = execute(self.ws, self.app.state.queries, snapshot, 'read_tool_result',
                         dict(turn_id=turns[-1]['id'], offset=0, limit=30))
        self.assertEqual(len(result['text']), 30)
        self.assertGreater(result['total_characters'], 30)
        self.assertIn(snapshot['source'], result['source_ids'])
        other = self.ws.create(command(name='other'))['project_id']
        with self.assertRaises(LookupError):
            execute(self.ws, self.app.state.queries, {**snapshot, 'project':other}, 'read_tool_result',
                    dict(turn_id=turns[-1]['id'], offset=0, limit=30))

    def test_forgetting_origin_redacts_consumers_of_expanded_tool_results(self):
        origin = self.tasks.create(self.project, command(expected_head=self.head, statement='原始私有要求', max_jobs=3,
                                  plan=[dict(tool='finish', arguments=dict(summary='私有方案回执', outcome='answer'))]))['task_id']
        self.tasks.step(origin)
        self.tasks.step(origin)
        original, turns = self.tasks.snapshot(origin)
        consumer = self.tasks.create(self.project, command(expected_head=self.head, statement='展开旧回执', max_jobs=3,
                                    plan=[dict(tool='read_tool_result', arguments=dict(turn_id=turns[0]['id']))]))['task_id']
        self.tasks.step(consumer)
        self.tasks.step(consumer)
        self.assertIn('私有方案回执', packed(self.tasks.get(consumer)))
        forgotten = self.tasks.forget(self.project, command(source_id=original['source']))
        self.assertIn(consumer, forgotten['cancelled_task_ids'])
        self.assertNotIn('私有方案回执', packed(self.tasks.get(consumer)))

    def failed_build(self, task, error, ordinal):
        snapshot, _ = self.tasks.snapshot(task)
        job, turn = identity(), identity()
        args = dict(script='result=u.create_box((0,0,0),1,2,3)', parameters={}, tolerance_mm=.05,
                    angle_deg=10, use_current=True, replay_of=None)
        with self.ws.db() as db:
            db.execute('INSERT INTO jobs(id,project,revision,kind,input,state,error,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                       (job, self.project, self.head, 'cad', '{}', 'failed', error, time.time(), time.time()))
            db.execute('INSERT INTO agent_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (turn, task, snapshot['epoch'], ordinal, self.head, 'waiting_job',
                        packed(dict(tool='build_geometry', arguments=args)), packed(args), packed(dict(job_id=job)), job, None, time.time()))
            db.execute("UPDATE agent_tasks SET state='waiting_job',turns=? WHERE id=?", (ordinal + 1, task))
        return turn

    def test_script_failure_returns_to_planner_with_error_and_saved_inputs(self):
        task = self.model()
        failed_id = self.failed_build(task, 'RuntimeError: CadScriptFailure: invalid radius', 0)
        self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'executing')
        self.assertEqual(value['steps'][0]['state'], 'failed')
        self.assertTrue(value['steps'][0]['receipt']['recoverable'])
        with patch('backend.vision.provider.complete', return_value=response('ask_user', dict(question='原生接口拒绝该尺寸，已保留失败证据。'))) as complete:
            self.tasks.step(task)
        compiled = json.loads(complete.call_args.args[0]['messages'][1]['content'])
        self.assertEqual(compiled['latest_failure']['turn_id'], failed_id)
        self.assertIn('invalid radius', compiled['latest_failure']['error'])
        snapshot, turns = self.tasks.snapshot(task)
        result = execute(self.ws, self.app.state.queries, snapshot, 'read_tool_result', dict(turn_id=failed_id, offset=0, limit=8000))
        self.assertIn('result=u.create_box', result['text'])
        with self.assertRaisesRegex(CadScriptError, '没有改变'):
            prepare(snapshot, dict(tool='build_geometry', arguments=json.loads(turns[0]['arguments'])), turns)
        corrected = json.loads(turns[0]['arguments'])
        corrected['script'] = 'result=u.create_box((0,0,0),2,2,3)'
        self.assertEqual(prepare(snapshot, dict(tool='build_geometry', arguments=corrected), turns)['script'], corrected['script'])
        with self.ws.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0], 1)

    def test_retry_limit_and_infrastructure_failures_pause(self):
        for error in ('RuntimeError: PermissionError: denied', 'native attempt exceeded its execution budget', 'native worker exited without a receipt'):
            task = self.model()
            self.failed_build(task, error, 0)
            self.tasks.step(task)
            self.assertEqual(self.tasks.get(task)['state'], 'waiting_user')
        task = self.model()
        for ordinal in range(3):
            self.failed_build(task, 'RuntimeError: CadScriptFailure: bad shape', ordinal)
            self.tasks.step(task)
            self.assertEqual(self.tasks.get(task)['state'], 'executing' if ordinal < 2 else 'waiting_user')

    def test_recovery_cannot_continue_after_head_changes(self):
        task = self.model()
        self.failed_build(task, 'RuntimeError: CadScriptFailure: bad shape', 0)
        self.ws.edit(self.project, command(expected_head=self.head), lambda db, doc: {**doc, 'name':'changed'})
        self.tasks.step(task)
        self.assertEqual(self.tasks.get(task)['state'], 'waiting_user')
        self.assertIn('project changed', self.tasks.get(task)['error'])

    def test_recovery_cannot_overwrite_concurrent_cancellation(self):
        task = self.model()
        self.failed_build(task, 'RuntimeError: CadScriptFailure: bad shape', 0)
        read = self.ws.job
        def cancelled(job_id):
            job = read(job_id)
            self.tasks.change(task, command(expected_epoch=1))
            return job
        with patch.object(self.ws, 'job', side_effect=cancelled):
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'cancelled')
        self.assertEqual(value['epoch'], 2)
        self.assertEqual(value['steps'][0]['state'], 'superseded')


if __name__ == '__main__':
    unittest.main()
