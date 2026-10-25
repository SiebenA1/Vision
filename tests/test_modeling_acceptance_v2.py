"""Acceptance is derived from the current artifact and registered source-linked checks."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.vision.api import create_app
from backend.vision.contracts import ModelingRequirement, SetModelingRequirements, Document
from backend.vision.engineering_memory import record
from backend.vision.modeling import assess_geometry, set_requirements
from backend.vision.storage import Conflict, identity, packed
from backend.vision.task_tools import execute
from backend.vision.task_memory import context
from backend.vision import provider, conversation
from test_modeling_recovery_v2 import command, response


class ModelingAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.ws, self.tasks = self.app.state.workspace, self.app.state.tasks
        p = self.ws.create(command(name='model acceptance'))
        self.project, self.head = p['project_id'], p['revision_id']
        self.source = identity()
        with self.ws.db() as db:
            db.execute('INSERT INTO sources VALUES(?,?,?,?)', (self.source, self.project,
                packed(dict(origin='user_task_input', text='建立长100mm的单实体梁；孔形态需要核验')), time.time()))
        self.env = patch.dict('os.environ', VISION_MEMORY_SEMANTIC='0')
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.app.state.queries.close()
        self.folder.cleanup()

    def criterion(self, metric='bbox_x_mm', **fields):
        return dict(name='长100mm', metric=metric, minimum=99.9, maximum=100.1, source_ids=[self.source], **fields)

    def goals(self, items):
        p = set_requirements(self.ws, self.project, command(expected_head=self.head, requirements=items))
        self.head = p['revision_id']

    def geometry(self, length=100):
        bounds = dict(min=[0., 0., 0.], max=[float(length), 20., 10.], size=[float(length), 20., 10.])
        metrics = dict(bbox_mm=bounds, volume_mm3=float(length * 200), area_mm2=1000., mass_kg=1.)
        body = dict(id='body-0', stlFile='body-0.stl', kind='solid', name='100mm beam', faces=[], edges=[], **metrics)
        geometry = self.ws.artifacts.publish(self.folder.name, [], dict(kind='cad', schema='vision.cad/3',
            nativeSha256='a' * 64, kernelVersion='fixture', parameters=dict(length=100),
            settings=dict(tolerance_mm=.05, angle_deg=10), metrics=metrics, bodies=[body]))['artifactId']
        p = self.ws.edit(self.project, command(expected_head=self.head), lambda db, doc: {**doc, 'geometry':geometry})
        self.head = p['revision_id']
        return geometry

    def finish(self, outcome='answer', **task_fields):
        task = dict(id='completion-fixture', epoch=1, project=self.project, revision=self.head, **task_fields)
        return execute(self.ws, self.app.state.queries, task, 'finish', dict(summary='结束答复', outcome=outcome))

    def test_answer_completion_never_creates_a_model_or_verification(self):
        result = self.finish()
        self.assertEqual(result['completion']['status'], 'not_built')
        self.assertIsNone(result['completion']['artifact_id'])
        for outcome in ('built', 'partial', 'verified'):
            with self.subTest(outcome=outcome), self.assertRaises(ValueError):
                self.finish(outcome)

    def test_successful_build_without_requirements_is_unverified(self):
        self.geometry()
        self.assertEqual(self.finish('built')['completion']['status'], 'unverified')
        with self.assertRaises(ValueError):
            self.finish('verified')

    def test_registered_actual_bounds_and_counts_can_pass(self):
        self.goals([self.criterion(), dict(name='单个闭合实体', metric='solid_count', minimum=1, maximum=1, source_ids=[self.source])])
        geometry = self.geometry()
        result = self.finish('verified')['completion']
        self.assertEqual(result['status'], 'checks_passed')
        self.assertEqual(result['artifact_id'], geometry)
        self.assertEqual(result['scope'], 'registered_modeling_requirements_only')
        self.assertTrue(all(check['status'] == 'pass' for check in result['checks']))

    def test_parameters_and_body_names_cannot_substitute_for_measured_geometry(self):
        self.goals([self.criterion()])
        self.geometry(length=50)
        result = self.finish('partial')['completion']
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['checks'][0]['actual'], 50)
        with self.assertRaises(ValueError):
            self.finish('verified')

    def test_manual_feature_remains_unknown_after_numeric_checks_pass(self):
        self.goals([self.criterion(), dict(name='通孔的形态', metric='manual', source_ids=[self.source])])
        self.geometry()
        self.assertEqual(self.finish('partial')['completion']['status'], 'needs_review')
        with self.assertRaises(ValueError):
            self.finish('verified')

    def test_old_geometry_checks_cannot_certify_a_changed_artifact(self):
        self.goals([self.criterion()])
        before = self.geometry()
        self.assertEqual(assess_geometry(self.ws, self.project)['status'], 'checks_passed')
        after = self.geometry(50)
        result = self.finish('partial')['completion']
        self.assertNotEqual(before, after)
        self.assertEqual(result['status'], 'failed')
        old_revision = self.ws.history(self.project)[1]['revision_id']
        with self.assertRaises(Conflict):
            execute(self.ws, self.app.state.queries, dict(id='old', epoch=1, project=self.project, revision=old_revision),
                    'finish', dict(summary='旧检查', outcome='verified'))

    def test_cross_project_sources_and_stale_head_do_not_replace_goals(self):
        other = self.ws.create(command(name='other'))['project_id']
        foreign = identity()
        with self.ws.db() as db:
            db.execute('INSERT INTO sources VALUES(?,?,?,?)', (foreign, other, packed(dict(origin='user_task_input', text='foreign')), time.time()))
        bad = {**self.criterion(), 'source_ids':[foreign]}
        with self.assertRaises(ValueError):
            self.goals([bad])
        old = self.head
        self.goals([self.criterion()])
        with self.assertRaises(Conflict):
            set_requirements(self.ws, self.project, command(expected_head=old, requirements=[self.criterion()]))

    def test_forgotten_requirement_is_unknown_and_does_not_break_new_context(self):
        self.goals([self.criterion()])
        self.geometry()
        self.tasks.forget(self.project, command(source_id=self.source))
        result = assess_geometry(self.ws, self.project)
        self.assertEqual(result['status'], 'needs_review')
        self.assertNotIn(self.source, result['source_ids'])

    def test_requirement_schema_rejects_impossible_bounds_and_fractional_counts(self):
        for fields in (dict(minimum=10, maximum=5), dict(metric='manual'), dict(metric='body_count', minimum=1.5)):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                ModelingRequirement.model_validate({**self.criterion(), **fields})

    def test_requirement_budget_applies_to_both_commands_and_stored_documents(self):
        items = [dict(name='目标' * 150, metric='bbox_x_mm', minimum=0, source_ids=[str(i) + 'a' * 150 for i in range(16)]) for _ in range(24)]
        with self.assertRaisesRegex(ValueError, '12000-character'):
            SetModelingRequirements.model_validate(command(expected_head=self.head, requirements=items))
        with self.assertRaisesRegex(ValueError, '12000-character'):
            Document(name='oversized', modeling_requirements=items)

    def test_optional_bounds_in_an_imported_document_are_normalized(self):
        p = self.ws.edit(self.project, command(expected_head=self.head), lambda db, doc: {**doc,
            'modeling_requirements':[dict(name='至少一个实体', metric='solid_count', minimum=1, source_ids=[self.source])]})
        self.head = p['revision_id']
        self.geometry()
        result = self.finish('verified')['completion']
        self.assertEqual(result['status'], 'checks_passed')
        self.assertIsNone(result['checks'][0]['requirement']['maximum'])

    def test_model_gets_completion_rejection_and_can_reply_honestly(self):
        with patch('backend.vision.provider.api_key', return_value='offline'):
            task = self.tasks.create(self.project, command(expected_head=self.head, statement='建立模型', max_jobs=3,
                max_requests=12, unlimited=True), model=True)['task_id']
        self.tasks.step(task)
        replies = [response('finish', dict(summary='已完成', outcome='verified'), 'bad'),
                   response('finish', dict(summary='尚未构建，不能报告完成', outcome='answer'), 'honest')]
        with patch('backend.vision.provider.complete', side_effect=replies) as complete:
            self.tasks.step(task)
            self.assertEqual(self.tasks.get(task)['steps'][0]['state'], 'rejected')
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'completed')
        self.assertEqual(value['steps'][-1]['receipt']['completion']['status'], 'not_built')
        sent = json.loads(complete.call_args.args[0]['messages'][1]['content'])
        self.assertIn('当前没有几何模型', sent['last_tool_rejection']['reason'])

    def test_goal_write_advances_task_revision_and_is_retained_in_next_request(self):
        with patch('backend.vision.provider.api_key', return_value='offline'):
            task = self.tasks.create(self.project, command(expected_head=self.head, statement='长100mm单实体梁', max_jobs=3,
                max_requests=12, unlimited=True), model=True)['task_id']
        self.tasks.step(task)
        with patch('backend.vision.provider.complete', return_value=response('set_modeling_requirements', dict(requirements=[self.criterion()]), 'goal')):
            self.tasks.step(task)
        self.assertNotEqual(self.tasks.get(task)['revision'], self.head)
        with patch('backend.vision.provider.complete', return_value=response('finish', dict(summary='已登记要求，尚未构建'), 'finish')) as complete:
            self.tasks.step(task)
        compiled = json.loads(complete.call_args.args[0]['messages'][1]['content'])
        self.assertEqual(compiled['project']['modeling_requirements'][0]['name'], '长100mm')
        self.assertEqual(compiled['model_completion_state']['status'], 'not_built')

    def test_identical_requirements_do_not_create_revision_churn(self):
        self.goals([self.criterion()])
        head = self.head
        self.goals([self.criterion()])
        self.assertEqual(self.head, head)

    def test_superseded_requirement_invalidates_cached_checks_and_build_gate(self):
        old = record(self.ws, self.project, command(expected_head=self.head, kind='requirement', scope='project',
            summary='长100mm', source_ids=[self.source], supersedes=[]))['source_id']
        self.goals([{**self.criterion(), 'source_ids':[old]}])
        self.geometry()
        checked = assess_geometry(self.ws, self.project)
        record(self.ws, self.project, command(expected_head=self.head, kind='requirement', scope='project',
            summary='改成50mm', source_ids=[self.source], supersedes=[old]))
        task = dict(id='fixture', project=self.project, revision=self.head, epoch=1, source=self.source)
        turn = dict(id='old-check', epoch=1, revision=self.head, state='succeeded',
                    response=packed(dict(tool='check_modeling')), receipt=packed(checked))
        with patch('backend.vision.retrieval.retrieve', return_value=([], {})):
            compiled, _ = context(self.ws, task, [turn], budget=24000)
        self.assertEqual(compiled['model_completion_state']['status'], 'needs_review')
        self.assertEqual(compiled['latest_observation']['receipt']['status'], 'unknown')
        compiled['cad_api_signatures'] = [{'symbol':'usd_brep.create_box','signature':'create_box(origin,length,width,height)'}]
        names = {tool['function']['name'] for tool in provider.payload(compiled, 'deepseek-flash')['tools']}
        self.assertNotIn('build_geometry', names)
        self.assertIn('set_modeling_requirements', names)

    def test_conversation_revalidates_source_changes_without_a_geometry_revision(self):
        old = record(self.ws, self.project, command(expected_head=self.head, kind='requirement', scope='project',
            summary='长100mm', source_ids=[self.source], supersedes=[]))['source_id']
        self.goals([{**self.criterion(), 'source_ids':[old]}])
        self.geometry()
        with patch('backend.vision.provider.api_key', return_value='offline'):
            created = conversation.send(self.tasks, self.project, command(expected_head=self.head, text='核验当前模型',
                expected_task=None, expected_epoch=None, artifact_id=None, selection=[]))
        self.tasks.step(created['task_id'])
        with patch('backend.vision.provider.complete', return_value=response('finish', dict(summary='已登记检查项通过', outcome='verified'))):
            self.tasks.step(created['task_id'])
        before = conversation.read(self.tasks, self.project)
        self.assertEqual(before['messages'][-1]['completion']['status'], 'checks_passed')
        record(self.ws, self.project, command(expected_head=self.head, kind='requirement', scope='project',
            summary='改成50mm', source_ids=[self.source], supersedes=[old]))
        after = conversation.read(self.tasks, self.project)
        self.assertEqual(after['messages'][-1]['completion']['status'], 'needs_review')
        self.assertEqual(after['messages'][-1]['completion']['checks'], [])

    def test_imported_metrics_cannot_be_promoted_to_local_verification(self):
        self.goals([self.criterion()])
        geometry = self.geometry()
        with self.ws.db() as db:
            db.execute('INSERT INTO jobs(id,project,revision,kind,input,state,result,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
                       (identity(), self.project, self.head, 'cad', '{}', 'succeeded',
                        packed(dict(artifact_id=geometry, origin='imported')), time.time(), time.time()))
        self.assertEqual(self.finish('built')['completion']['status'], 'needs_review')
        with self.assertRaises(ValueError):
            self.finish('verified')

    def test_imported_geometry_without_job_history_also_needs_native_verification(self):
        self.goals([self.criterion()])
        self.geometry()
        with self.ws.db() as db:
            value = json.loads(db.execute('SELECT payload FROM sources WHERE id=?', (self.source,)).fetchone()[0])
            db.execute('UPDATE sources SET payload=? WHERE id=?',
                       (packed({**value, 'origin':'imported_source', 'original_origin':value['origin']}), self.source))
        self.assertEqual(self.finish('built')['completion']['status'], 'needs_review')
        with self.assertRaises(ValueError):
            self.finish('verified')

    def test_latest_failed_build_cannot_borrow_a_passing_old_artifact(self):
        self.goals([self.criterion()])
        self.geometry()
        with patch('backend.vision.provider.api_key', return_value='offline'):
            task_id = self.tasks.create(self.project, command(expected_head=self.head, statement='修改模型', max_jobs=3,
                max_requests=12, unlimited=True), model=True)['task_id']
        task, _ = self.tasks.snapshot(task_id)
        with self.ws.db() as db:
            db.execute('INSERT INTO agent_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', (identity(), task_id, 1, 0, self.head,
                'failed', packed(dict(tool='build_geometry')), '{}', '{}', None, 'build failed', time.time()))
        for outcome in ('built', 'verified'):
            with self.subTest(outcome=outcome), self.assertRaises(ValueError):
                execute(self.ws, self.app.state.queries, task, 'finish', dict(summary='不能沿用旧成功', outcome=outcome))

    def test_large_but_valid_requirements_and_summary_fit_completion_receipt(self):
        items = [dict(name='要求' + str(index) + '长' * 285, metric='bbox_x_mm', minimum=0, maximum=200,
                      source_ids=[self.source]) for index in range(24)]
        self.goals(items)
        self.geometry()
        result = self.finish('verified')
        result['summary'] = '结' * 4000
        self.assertLessEqual(len(packed(result)), 24000)

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / '.python312/python.exe').is_file(), 'requires local CAD runtime')
    def test_multi_turn_real_cad_build_update_and_verified_reply(self):
        def send(text, task_id=None):
            self.head = self.ws.revision(self.project)['revision_id']
            current = self.tasks.get(task_id) if task_id else None
            with patch('backend.vision.provider.api_key', return_value='offline'):
                return conversation.send(self.tasks, self.project, command(expected_head=self.head, text=text,
                    expected_task=task_id, expected_epoch=current['epoch'] if current else None, artifact_id=None, selection=[]))
        first = send('建立长7mm、宽2mm、高3mm的单实体梁。')
        task_id = first['task_id']
        self.tasks.step(task_id)
        script = 'result=u.create_box((0,0,0),parameters["length"],2,3)'
        first_goal = dict(name='长7mm', metric='bbox_x_mm', minimum=6.99, maximum=7.01, source_ids=[first['message_id']])
        first_replies = [response('set_modeling_requirements', dict(requirements=[first_goal]), 'goal1'),
                         response('native_api', dict(query='create_box', limit=1), 'api1'),
                         response('build_geometry', dict(script=script, parameters=dict(length=7), use_current=False), 'build1'),
                         response('finish', dict(summary='7mm模型的已登记尺寸检查通过', outcome='verified'), 'finish1')]
        with patch('backend.vision.provider.complete', side_effect=first_replies) as complete:
            for _ in range(3):
                self.tasks.step(task_id)
            self.assertEqual(self.tasks.get(task_id)['state'], 'waiting_job')
            self.assertEqual(self.tasks.get(task_id)['jobs'], 1)
            job = self.ws.claim()
            self.assertIsNotNone(job)
            self.app.state.controller.run(job)
            self.assertEqual(self.ws.job(job['id'])['state'], 'succeeded', self.ws.job(job['id'])['error'])
            for _ in range(2):
                self.tasks.step(task_id)
            self.assertEqual(complete.call_count, 4)
        self.assertEqual(self.tasks.get(task_id)['state'], 'completed')
        before = self.ws.revision(self.project)['document']['geometry']
        second = send('长度改为9mm，其余保持不变。', task_id)
        second_goal = dict(name='长9mm', metric='bbox_x_mm', minimum=8.99, maximum=9.01, source_ids=[second['message_id']])
        self.tasks.step(task_id)
        second_replies = [response('set_modeling_requirements', dict(requirements=[second_goal]), 'goal2'),
                          response('build_geometry', dict(script=script, parameters=dict(length=9), use_current=False), 'premature-build2'),
                          response('preview_build', dict(parameters=dict(length=9)), 'preview2'),
                          response('build_geometry', {}, 'build2'),
                          response('finish', dict(summary='9mm模型的已登记尺寸检查通过', outcome='verified'), 'finish2')]
        with patch('backend.vision.provider.complete', side_effect=second_replies) as complete:
            for _ in range(4):
                self.tasks.step(task_id)
            self.assertEqual(self.tasks.get(task_id)['state'], 'waiting_job')
            self.assertEqual(self.tasks.get(task_id)['jobs'], 1)
            self.assertEqual(sum(step['state'] == 'rejected' for step in self.tasks.get(task_id)['steps']), 1)
            job = self.ws.claim()
            self.app.state.controller.run(job)
            self.assertEqual(self.ws.job(job['id'])['state'], 'succeeded', self.ws.job(job['id'])['error'])
            for _ in range(2):
                self.tasks.step(task_id)
            self.assertEqual(complete.call_count, 5)
        after = self.ws.revision(self.project)['document']['geometry']
        self.assertNotEqual(before, after)
        view = conversation.read(self.tasks, self.project)
        answers = [message for message in view['messages'] if message['role'] == 'assistant']
        self.assertEqual(answers[-1]['completion']['status'], 'checks_passed')
        self.assertEqual(answers[-1]['completion']['artifact_id'], after)
        self.assertEqual(answers[0]['completion']['status'], 'needs_review')
        self.assertAlmostEqual(answers[-1]['completion']['checks'][0]['actual'], 9, places=3)

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / '.python312/python.exe').is_file(), 'requires local CAD runtime')
    def test_native_geometry_checks_use_real_worker_metrics(self):
        from backend.vision.native import run_cad
        self.goals([dict(name='长度7mm', metric='bbox_x_mm', minimum=6.99, maximum=7.01, source_ids=[self.source])])
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            result = run_cad(dict(script='result=u.create_box((0,0,0),7,2,3)', options={}), Path(folder))
            result.pop('stlBase64', None)
            result.pop('stlBytes', None)
            manifest = self.ws.artifacts.publish(folder, ['body-0.brep', 'body-0.stl'], {**result, 'kind':'cad'})
        p = self.ws.edit(self.project, command(expected_head=self.head), lambda db, doc:{**doc, 'geometry':manifest['artifactId']})
        self.head = p['revision_id']
        checked = self.finish('verified')['completion']
        self.assertEqual(checked['status'], 'checks_passed')
        self.assertAlmostEqual(checked['checks'][0]['actual'], 7, places=3)


if __name__ == '__main__':
    unittest.main()
