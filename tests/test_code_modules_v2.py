"""Acceptance of registry, exact code versions, source bindings and incremental CAD."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from backend.vision.api import create_app
from backend.vision import code_modules
from backend.vision.changes import preview_build
from backend.vision.contracts import Build
from backend.vision.storage import packed,identity,Missing,Conflict
from backend.vision.bundles import export_project,import_project


def command(**fields):
    key=identity();return {'command_id':key,'idempotency_key':key,**fields}


class CodeModuleTest(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app=create_app(self.folder.name,run_jobs=False);self.ws=self.app.state.workspace
        rev=self.ws.create(command(name='module acceptance'))
        self.project,self.head=rev['project_id'],rev['revision_id']
        with self.ws.db() as db:
            db.execute('INSERT INTO sources VALUES(?,?,?,?)',('user',self.project,packed({'origin':'user_task_input','text':'Build a storage box and floating lid'}),time.time()))

    def tearDown(self):
        self.app.state.queries.close();self.folder.cleanup()

    def register(self,name='block',script='result=u.create_box((0,0,0),parameters["height"],2,3)',**fields):
        return code_modules.register(self.ws,self.project,command(expected_head=self.head,module_id=name,
             description=name+' reusable mechanical module',script=script,
             parameters=fields.pop('parameters',{'height':{'type':'number','default':7,'unit':'mm','minimum':1}}),
             tags=['mechanical',name],source_ids=['user'],bindings=[{'requirement_id':'R1','source_id':'user','feature':'specified shape'}],**fields))

    def build(self,assembly,**options):
        self.head=self.ws.revision(self.project)['revision_id']
        request=Build(**command(expected_head=self.head,module_assembly=assembly,**options)).model_dump()
        if self.ws.revision(self.project)['document']['geometry']:
            request['expected_impact_digest']=preview_build(self.ws,self.project,request)['digest']
        self.ws.enqueue(self.project,request,'cad');job=self.ws.claim();self.app.state.controller.run(job)
        actual=self.ws.job(job['id']);self.assertEqual(actual['state'],'succeeded',actual['error'])
        self.head=self.ws.revision(self.project)['revision_id']
        return self.ws.artifacts.manifest(actual['result']['artifact_id']),actual['result']

    def test_registry_returns_exact_bounded_source_and_no_code_in_search(self):
        module=self.register()
        found=code_modules.search(self.ws,self.project,{'query':'block','parameter_names':['height'],'limit':4})
        self.assertEqual(found['modules'][0]['code_revision'],module['code_revision'])
        self.assertNotIn('create_box',packed(found))
        read=code_modules.read(self.ws,self.project,{**module,'offset':0,'limit':10})
        self.assertEqual(len(read['text']),10);self.assertTrue(read['truncated'])
        self.assertEqual(read['bindings'][0]['requirement_id'],'R1')
        with patch('backend.vision.code_modules.compatibility_id',return_value='other-runtime'):
            self.assertEqual(code_modules.search(self.ws,self.project,{'limit':4})['modules'],[])
            with self.assertRaises(Conflict):code_modules.read(self.ws,self.project,module)

    def test_versions_patch_and_command_identity_are_immutable(self):
        first=self.register()
        request=command(expected_head=self.head,module_id='block',code_revision=first['code_revision'],
                        script_edits=[{'old_text':',2,3)', 'new_text':',4,3)'}],source_ids=['user'])
        second=code_modules.patch_module(self.ws,self.project,request)
        self.assertNotEqual(first['code_revision'],second['code_revision'])
        self.assertIn(',2,3)',code_modules.read(self.ws,self.project,first)['text'])
        self.assertIn(',4,3)',code_modules.read(self.ws,self.project,second)['text'])
        self.assertEqual(second,code_modules.patch_module(self.ws,self.project,request))
        bad=copy.deepcopy(request);bad['script_edits'][0]['new_text']=',5,3)'
        with self.assertRaises(Conflict):code_modules.patch_module(self.ws,self.project,bad)

    def test_sources_and_projects_isolate_modules(self):
        module=self.register()
        other=self.ws.create(command(name='other'))['project_id']
        with self.assertRaises(Missing):code_modules.read(self.ws,other,module)
        with self.ws.db() as db:db.execute('UPDATE sources SET payload=? WHERE id=?',(packed({'origin':'deleted'}),'user'))
        self.assertEqual(code_modules.search(self.ws,self.project,{'limit':4})['modules'],[])
        with self.assertRaises(Missing):code_modules.read(self.ws,self.project,module)

    def test_http_registry_and_bounded_read(self):
        from fastapi.testclient import TestClient
        with TestClient(self.app) as client:
            registered=client.post(f'/api/v2/projects/{self.project}/code-modules',json=command(expected_head=self.head,
                module_id='http_block',description='HTTP test',script='result=u.create_box((0,0,0),1,2,3)',source_ids=['user']))
            self.assertEqual(registered.status_code,200,registered.text)
            module=registered.json()
            found=client.post(f'/api/v2/projects/{self.project}/code-modules/search',json={'query':'HTTP'})
            self.assertEqual(found.status_code,200,found.text)
            self.assertEqual(found.json()['modules'][0]['code_revision'],module['code_revision'])
            reply=client.post(f'/api/v2/projects/{self.project}/code-modules/read',json={
                'module_id':module['module_id'],'code_revision':module['code_revision'],'limit':6})
            self.assertEqual(reply.json()['text'],'result')

    def test_invalid_parameter_units_bounds_cycles_and_forward_references_reject(self):
        module=self.register()
        base={'module_id':'block','code_revision':module['code_revision'],'component_id':'a'}
        for changed in ({'parameters':{'height':0}},{'parameters':{'typo':7}},{'parameters':{'height':True}}, {'depends_on':['missing']}):
            with self.assertRaises(ValueError):code_modules.resolve(self.ws,self.project,{},[{**base,**changed}])
        with self.assertRaises(ValueError):code_modules.resolve(self.ws,self.project,{},[base,base])
        with self.assertRaises(ValueError):
            code_modules.resolve(self.ws,self.project,{},[{**base,'translation':[0,0,{'component_id':'later','parameter':'height'}]}])
        cm=self.register('centimeter',parameters={'height':{'type':'number','unit':'cm','default':7}})
        with self.assertRaises(ValueError):
            code_modules.resolve(self.ws,self.project,{},[{'component_id':'cm','module_id':'centimeter','code_revision':cm['code_revision']},
                 {**base,'parameters':{'height':{'component_id':'cm','parameter':'height'}}}])

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(),'requires CAD runtime')
    def test_box_height_rebuilds_only_body_and_repositions_cached_lid(self):
        number=lambda default:{'type':'number','default':default,'unit':'mm','minimum':.1}
        body=self.register('box_body','p=parameters\nouter=u.create_box((0,0,0),p["width"],p["depth"],p["height"])\n'
             'inner=u.create_box((3,3,3),p["width"]-6,p["depth"]-6,p["height"])\nresult=u.boolean_difference(outer,inner)',
             parameters={key:number(value) for key,value in {'width':120,'depth':80,'height':40}.items()})
        lid=self.register('lid','p=parameters\nouter=u.create_box((-2.8,-2.8,0),p["width"]+5.6,p["depth"]+5.6,15)\n'
             'inner=u.create_box((-.3,-.3,-1),p["width"]+.6,p["depth"]+.6,13)\nresult=u.boolean_difference(outer,inner)',
             parameters={'width':number(120),'depth':number(80)})
        ref=lambda parameter,offset=0:{'component_id':'body','parameter':parameter,'offset':offset}
        assembly=[{'component_id':'body','module_id':'box_body','code_revision':body['code_revision'],'parameters':{'height':40},'requirement_ids':['R1']},
                  {'component_id':'lid','module_id':'lid','code_revision':lid['code_revision'],
                   'parameters':{'width':ref('width'),'depth':ref('depth')},'translation':[0,0,ref('height',30)]}]
        first,result=self.build(assembly)
        self.assertEqual(result['module_rebuild']['rebuilt'],['body','lid'])
        self.assertAlmostEqual(first['bodies'][1]['bbox_mm']['min'][2],70,places=3)
        assembly[0]['parameters']['height']=50
        second,result=self.build(assembly)
        self.assertEqual(result['module_rebuild'],{'rebuilt':['body'],'reused':['lid']})
        self.assertEqual(result['module_mesh_reused'],['lid'])
        self.assertAlmostEqual(second['bodies'][0]['bbox_mm']['max'][2],50,places=3)
        self.assertAlmostEqual(second['bodies'][1]['bbox_mm']['min'][2],80,places=3)
        self.assertAlmostEqual(first['bodies'][1]['volume_mm3'],second['bodies'][1]['volume_mm3'],places=3)
        self.assertEqual(len(second['bodies']),2)
        _,result=self.build(assembly)
        self.assertEqual(result['module_rebuild'],{'rebuilt':[],'reused':['body','lid']})
        self.assertEqual(result['module_mesh_reused'],['body','lid'])
        current=self.ws.revision(self.project)['document']['geometry']
        from backend.vision.task_tools import prepare
        edit=prepare({'id':'edit','epoch':1,'turns':0,'project':self.project,'revision':self.head},
                     {'tool':'preview_build','arguments':{'base_assembly_artifact':current,'assembly_edits':[{'component_id':'body','parameters':{'height':60}}]}},[],self.ws)
        self.assertEqual(edit['module_assembly'][1]['translation'][2]['component_id'],'body')
        fourth,result=self.build(edit['module_assembly'])
        self.assertEqual(result['module_rebuild'],{'rebuilt':['body'],'reused':['lid']})
        self.assertAlmostEqual(fourth['bodies'][1]['bbox_mm']['min'][2],90,places=3)

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(),'requires CAD runtime')
    def test_geometry_dependencies_invalidate_and_rotations_reuse_canonical_mesh(self):
        module=self.register()
        a={'component_id':'a','module_id':'block','code_revision':module['code_revision'],'rotation_deg':[0,0,90]}
        first,_=self.build([a])
        a['rotation_deg']=[0,0,180];a['translation']=[10,0,0]
        second,result=self.build([a])
        self.assertEqual(result['module_rebuild']['reused'],['a'])
        self.assertEqual(result['module_mesh_reused'],['a'])
        self.assertEqual(first['files']['module-0.stl'],second['files']['module-0.stl'])
        self.assertAlmostEqual(second['bodies'][0]['bbox_mm']['size'][0],7,places=3)
        _,result=self.build([a],tolerance_mm=.01)
        self.assertEqual(result['module_rebuild']['reused'],['a'])
        self.assertEqual(result['module_mesh_reused'],[])
        dependent=self.register('dependent','result=parts["a"]',parameters={})
        assembly=[a,{'component_id':'b','module_id':'dependent','code_revision':dependent['code_revision'],'depends_on':['a']}]
        self.build(assembly);assembly[0]['parameters']={'height':9}
        _,result=self.build(assembly)
        self.assertEqual(result['module_rebuild']['rebuilt'],['a','b'])

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(),'requires CAD runtime')
    def test_bundle_keeps_module_code_and_import_does_not_trust_cache(self):
        module=self.register();assembly=[{'component_id':'block','module_id':'block','code_revision':module['code_revision']}]
        self.build(assembly);bundle=export_project(self.ws,self.project)
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            app=create_app(folder,run_jobs=False)
            import_project(app.state.workspace,bundle,command())
            self.assertIn('create_box',code_modules.read(app.state.workspace,self.project,module)['text'])
            _,metadata=code_modules.resolve(app.state.workspace,self.project,app.state.workspace.revision(self.project)['document'],assembly)
            self.assertEqual(metadata['rebuilt'],['block'])
            app.state.queries.close()

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(),'requires CAD runtime')
    def test_code_change_invalidates_only_target_and_failure_keeps_good_geometry(self):
        first=self.register();other=self.register('other')
        assembly=[{'component_id':name,'module_id':module['module_id'],'code_revision':module['code_revision']}
                  for name,module in [('a',first),('b',other)]]
        self.build(assembly)
        patched=code_modules.patch_module(self.ws,self.project,command(expected_head=self.head,module_id='block',
            code_revision=first['code_revision'],script_edits=[{'old_text':',2,3)', 'new_text':',4,3)'}],source_ids=['user']))
        assembly[0]['code_revision']=patched['code_revision']
        geometry,result=self.build(assembly)
        self.assertEqual(result['module_rebuild'],{'rebuilt':['a'],'reused':['b']})
        self.assertAlmostEqual(geometry['bodies'][0]['bbox_mm']['size'][1],4,places=3)
        good=self.ws.revision(self.project)['document']['geometry']
        broken=self.register('broken','raise ValueError("module failure")',parameters={})
        assembly[0].update(module_id='broken',code_revision=broken['code_revision'])
        request=Build(**command(expected_head=self.head,module_assembly=assembly)).model_dump()
        request['expected_impact_digest']=preview_build(self.ws,self.project,request)['digest']
        self.ws.enqueue(self.project,request,'cad');job=self.ws.claim();self.app.state.controller.run(job)
        failed=self.ws.job(job['id'])
        self.assertEqual(failed['state'],'failed')
        self.assertIn('a@'+broken['code_revision'],packed(failed['error']))
        self.assertEqual(self.ws.revision(self.project)['document']['geometry'],good)

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(),'requires CAD runtime')
    def test_source_withdrawn_after_queue_cannot_adopt_geometry(self):
        module=self.register()
        request=Build(**command(expected_head=self.head,module_assembly=[{'component_id':'a','module_id':'block',
                            'code_revision':module['code_revision']}])).model_dump()
        self.ws.enqueue(self.project,request,'cad')
        with self.ws.db() as db:db.execute('UPDATE sources SET payload=? WHERE id=?',(packed({'origin':'deleted'}),'user'))
        job=self.ws.claim();self.app.state.controller.run(job)
        self.assertEqual(self.ws.job(job['id'])['state'],'failed')
        self.assertIsNone(self.ws.revision(self.project)['document']['geometry'])

    @unittest.skipUnless(Path(__file__).resolve().parents[1].joinpath('.python312/python.exe').is_file(),'requires CAD runtime')
    def test_agent_builds_by_reference_without_source_retransmission(self):
        from backend.vision import conversation
        from test_modeling_recovery_v2 import response
        module=self.register()
        with patch('backend.vision.provider.api_key',return_value='offline'):
            sent=conversation.send(self.app.state.tasks,self.project,command(expected_head=self.head,
                text='Create a block using the registered module.',expected_task=None,expected_epoch=None,artifact_id=None,selection=[]))
        task=sent['task_id'];self.app.state.tasks.step(task)
        assembly=[{'component_id':'block','module_id':module['module_id'],'code_revision':module['code_revision']}]
        replies=[response('set_modeling_requirements',{'requirements':[{'name':'length7','metric':'bbox_x_mm',
                  'minimum':6.99,'maximum':7.01,'source_ids':[sent['message_id']]}]},'goals'),
                 response('build_geometry',{'module_assembly':assembly},'module-build'),
                 response('finish',{'outcome':'verified','summary':'已检查登记尺寸'},'done')]
        with patch('backend.vision.provider.complete',side_effect=replies) as complete:
            self.app.state.tasks.step(task);self.app.state.tasks.step(task)
            job=self.ws.claim();self.assertIsNotNone(job);self.app.state.controller.run(job)
            self.app.state.tasks.step(task);self.app.state.tasks.step(task)
            self.assertEqual(complete.call_count,3)
            for call in complete.call_args_list:
                context=json.loads(call.args[0]['messages'][1]['content'])
                self.assertNotIn('u.create_box',packed(context))
        value=self.app.state.tasks.get(task)
        self.assertEqual(value['state'],'completed',value.get('error'))
        self.assertEqual(value['jobs'],1)
        revision=self.ws.revision(self.project)
        with patch('backend.vision.provider.api_key',return_value='offline'):
            conversation.send(self.app.state.tasks,self.project,command(expected_head=revision['revision_id'],
                text='Change the length to 9 mm.',expected_task=task,expected_epoch=value['epoch'],artifact_id=None,selection=[]))
        self.app.state.tasks.step(task)
        replies=[response('set_modeling_requirements',{'requirements':[{'name':'length9','metric':'bbox_x_mm',
                  'minimum':8.99,'maximum':9.01,'source_ids':[self.app.state.tasks.get(task)['source']]}]},'new-goals'),
                 response('preview_build',{'base_assembly_artifact':revision['document']['geometry'],
                     'assembly_edits':[{'component_id':'block','parameters':{'height':9}}]},'edit'),
                 response('build_geometry',{},'execute-edit'),
                 response('finish',{'outcome':'verified','summary':'已更新长度并检查'},'edited')]
        with patch('backend.vision.provider.complete',side_effect=replies) as complete:
            for _ in range(3):self.app.state.tasks.step(task)
            job=self.ws.claim();self.assertIsNotNone(job);self.app.state.controller.run(job)
            self.app.state.tasks.step(task);self.app.state.tasks.step(task)
            self.assertEqual(complete.call_count,4)
            for call in complete.call_args_list:
                self.assertNotIn('u.create_box',call.args[0]['messages'][1]['content'])
        value=self.app.state.tasks.get(task)
        self.assertEqual(value['state'],'completed',value.get('error'))
        manifest=self.ws.artifacts.manifest(self.ws.revision(self.project)['document']['geometry'])
        self.assertAlmostEqual(manifest['bodies'][0]['bbox_mm']['size'][0],9,places=3)
        from backend.vision.studies import native_study
        from test_tasks_v2 import STUDY
        stale={**copy.deepcopy(STUDY),'body_ids':[manifest['bodies'][0]['id']],
               'body_artifact_id':revision['document']['geometry']}
        with self.assertRaisesRegex(ValueError,'current geometry'):
            native_study({'study':stale,'geometry':self.ws.revision(self.project)['document']['geometry']})


if __name__=='__main__':unittest.main()
