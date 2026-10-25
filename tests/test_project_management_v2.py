"""Project lifecycle, irreversible deletion isolation, model preferences."""
import json
import os
import time
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision.storage import packed
from backend.vision.contracts import Build
from backend.vision.jobs import Controller
from test_tasks_v2 import command
from test_model_tasks_v2 import response


class ProjectManagementTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.ws = self.app.state.workspace
        self.project = self.client.post('/api/v2/projects', json=command('new', name=' Original ')).json()
        self.base = '/api/v2/projects/'+self.project['project_id']

    def tearDown(self):
        self.client.close()
        self.folder.cleanup()

    def delete_request(self, name='Original', head=None, key='delete'):
        return command(key, expected_head=head or self.project['revision_id'], confirmed_name=name)

    def test_names_and_rename_conflict(self):
        self.assertEqual(self.project['document']['name'], 'Original')
        self.assertEqual(self.client.post('/api/v2/projects',json=command('blank',name='  ')).status_code,422)
        renamed = self.client.post(self.base+'/rename',json=command('rename',expected_head=self.project['revision_id'],name=' Renamed '))
        self.assertEqual(renamed.status_code,200,renamed.text)
        self.assertEqual(renamed.json()['document']['name'],'Renamed')
        self.assertEqual(self.client.post(self.base+'/delete',json=self.delete_request()).status_code,409)
        self.assertEqual(self.client.get(self.base).status_code,200)

    def test_delete_requires_second_confirmation_and_preserves_other_projects(self):
        other=self.client.post('/api/v2/projects',json=command('other',name='Keep')).json()
        self.assertEqual(self.client.post(self.base+'/delete',json=command('missing',expected_head=self.project['revision_id'])).status_code,422)
        self.assertEqual(self.client.post(self.base+'/delete',json=self.delete_request(name='Wrong')).status_code,409)
        request=self.delete_request()
        deleted=self.client.post(self.base+'/delete',json=request)
        self.assertEqual(deleted.status_code,200,deleted.text)
        self.assertEqual(self.client.get(self.base).status_code,404)
        self.assertEqual(self.client.get('/api/v2/projects/'+other['project_id']).status_code,200)
        self.assertEqual(self.client.post(self.base+'/delete',json=request).json(),deleted.json())
        self.assertEqual(len(self.client.get('/api/v2/projects').json()),1)
        with self.ws.db() as db:
            for table in ('revisions','sources','agent_tasks','jobs'):
                self.assertEqual(db.execute(f'SELECT count(*) FROM {table} WHERE project=?',(self.project['project_id'],)).fetchone()[0],0)

    def test_stop_fences_tasks_and_delete_blocks_running_jobs(self):
        with patch('backend.vision.provider.api_key',return_value='test-only-key'):
            task=self.client.post(self.base+'/model-tasks',json=command('task',expected_head=self.project['revision_id'],statement='稍后执行')).json()['task_id']
        with patch('backend.vision.runtime.execution_settings',return_value={'profile':{}}):
            job=self.ws.enqueue(self.project['project_id'],Build(**command('job',expected_head=self.project['revision_id'],script='result=None')).model_dump(),'cad')['job_id']
        self.ws.claim()
        self.assertEqual(self.client.post(self.base+'/rename',json=command('rename',expected_head=self.project['revision_id'],name='Busy',require_idle=True)).status_code,409)
        self.assertEqual(self.client.post(self.base+'/delete',json=self.delete_request()).status_code,409)
        stopped=self.client.post(self.base+'/stop',json=command('stop',expected_head=self.project['revision_id']))
        self.assertEqual(stopped.status_code,200,stopped.text)
        self.assertEqual(self.app.state.tasks.get(task)['state'],'cancelled')
        self.assertEqual(self.ws.job(job)['state'],'cancelling')
        self.assertEqual(self.client.post(self.base+'/delete',json=self.delete_request()).status_code,409)
        self.ws.finish(job,'cancelled')
        self.assertEqual(self.client.post(self.base+'/delete',json=self.delete_request()).status_code,200)
        self.app.state.tasks.update(task,1,'waiting_user','late result')

    def artifact(self, tag, source=None):
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            names=[]
            if source:
                Path(folder,'input.json').write_text(packed({'document':{'geometry':source}}),encoding='utf-8')
                names=['input.json']
            return self.ws.artifacts.publish(folder,names,{'kind':'cad','tag':tag})['artifactId']

    def test_shared_dependencies_survive_and_unreferenced_files_are_removed(self):
        owned=self.artifact('owned')
        shared=self.artifact('shared',owned)
        unused=self.artifact('unused')
        head=self.ws.edit(self.project['project_id'],command('set-geometry',expected_head=self.project['revision_id']),lambda db,doc:{**doc,'geometry':owned})
        head=self.ws.edit(self.project['project_id'],command('set-unused',expected_head=head['revision_id']),lambda db,doc:{**doc,'geometry':unused})
        other=self.client.post('/api/v2/projects',json=command('other',name='Keep')).json()
        self.ws.edit(other['project_id'],command('keep-shared',expected_head=other['revision_id']),lambda db,doc:{**doc,'geometry':shared})
        result=self.client.post(self.base+'/delete',json=self.delete_request(head=head['revision_id']))
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['warnings'],[])
        self.assertTrue((self.ws.artifacts.root/owned).exists())
        self.assertTrue((self.ws.artifacts.root/shared).exists())
        self.assertFalse((self.ws.artifacts.root/unused).exists())

    def test_conversation_sources_receipts_and_run_logs_are_deleted(self):
        with patch('backend.vision.provider.api_key',return_value='test-only-key'):
            task=self.client.post(self.base+'/conversation',json=command('message',expected_head=self.project['revision_id'],text='Private conversation')).json()['task_id']
        self.app.state.tasks.step(task)
        with patch('backend.vision.provider.complete',return_value=response('finish',{'summary':'Private answer'})):
            self.app.state.tasks.step(task)
        with patch('backend.vision.runtime.execution_settings',return_value={'profile':{}}):
            job=self.ws.enqueue(self.project['project_id'],Build(**command('job',expected_head=self.project['revision_id'],script='result=None')).model_dump(),'cad')['job_id']
        log=self.ws.root/'runs'/job
        log.mkdir(parents=True)
        (log/'stdout.log').write_text('private log',encoding='utf-8')
        self.client.post(self.base+'/stop',json=command('stop',expected_head=self.project['revision_id']))
        result=self.client.post(self.base+'/delete',json=self.delete_request())
        self.assertEqual(result.status_code,200,result.text)
        self.assertFalse(log.exists())
        with self.ws.db() as db:
            self.assertFalse(db.execute('SELECT 1 FROM agent_turns WHERE task=?',(task,)).fetchone())
            values=' '.join(row[0]+row[1] for row in db.execute('SELECT request,response FROM receipts'))
            self.assertNotIn('Private',values)

    def test_broken_artifact_does_not_prevent_project_deletion(self):
        head=self.ws.edit(self.project['project_id'],command('missing-artifact',expected_head=self.project['revision_id']),lambda db,doc:{**doc,'geometry':'b'*64})
        result=self.client.post(self.base+'/delete',json=self.delete_request(head=head['revision_id']))
        self.assertEqual(result.status_code,200,result.text)
        self.assertTrue(result.json()['warnings'])
        self.assertEqual(self.client.get(self.base).status_code,404)

    def test_model_reply_arriving_after_permanent_deletion_cannot_execute(self):
        with patch('backend.vision.provider.api_key',return_value='test-only-key'):
            task=self.client.post(self.base+'/conversation',json=command('message',expected_head=self.project['revision_id'],text='查询接口')).json()['task_id']
        self.app.state.tasks.step(task)
        def late_reply(request):
            self.assertEqual(self.client.post(self.base+'/stop',json=command('stop',expected_head=self.project['revision_id'])).status_code,200)
            self.assertEqual(self.client.post(self.base+'/delete',json=self.delete_request()).status_code,200)
            return response('native_api',{'query':'box'})
        with patch('backend.vision.provider.complete',side_effect=late_reply),patch('backend.vision.tasks.execute') as execute:
            self.app.state.tasks.step(task)
            execute.assert_not_called()
        self.assertEqual(self.client.get(self.base).status_code,404)

    def test_model_settings_persist_and_apply_to_next_conversation(self):
        result=self.client.post('/api/v2/model-settings',json=command('settings',model='deepseek-v4-pro'))
        self.assertEqual(result.status_code,200,result.text)
        self.assertNotIn('api_key',result.json())
        with patch('backend.vision.provider.api_key',return_value='test-only-key'):
            sent=self.client.post(self.base+'/conversation',json=command('message',expected_head=self.project['revision_id'],text='测试配置'))
        self.assertEqual(sent.status_code,202,sent.text)
        self.assertEqual(self.app.state.tasks.get(sent.json()['task_id'])['config']['model'],'deepseek-v4-pro')
        with TestClient(create_app(self.folder.name,run_jobs=False)) as restored:
            self.assertEqual(restored.get('/api/v2/model-settings').json()['model'],'deepseek-v4-pro')
        self.assertEqual(self.client.post('/api/v2/model-settings',json=command('bad',model='unknown')).status_code,422)

    @unittest.skipUnless(os.environ.get('VISION_TEST_NATIVE_CORE')=='1','enable native stop/delete test')
    def test_real_worker_stops_before_permanent_deletion(self):
        job=self.ws.enqueue(self.project['project_id'],Build(**command('native-job',expected_head=self.project['revision_id'],
            script='import time\ntime.sleep(15)\nresult=u.create_box((0,0,0),10,10,10)')).model_dump(),'cad')['job_id']
        controller=Controller(self.ws)
        controller.start()
        try:
            until=time.monotonic()+15
            while not (self.ws.root/'runs'/job/'stdout.log').exists() and time.monotonic()<until:
                time.sleep(.1)
            self.assertEqual(self.ws.job(job)['state'],'running')
            stopped=self.client.post(self.base+'/stop',json=command('stop',expected_head=self.project['revision_id']))
            self.assertEqual(stopped.status_code,200,stopped.text)
            until=time.monotonic()+15
            while self.ws.job(job)['state']=='cancelling' and time.monotonic()<until:
                time.sleep(.1)
            self.assertEqual(self.ws.job(job)['state'],'cancelled')
            deleted=self.client.post(self.base+'/delete',json=self.delete_request())
            self.assertEqual(deleted.status_code,200,deleted.text)
            self.assertFalse((self.ws.root/'runs'/job).exists())
        finally:
            controller.close()


if __name__=='__main__':
    unittest.main()
