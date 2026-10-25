"""API lookup relevance, reuse, bounded context and non-progress regression."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision import provider
from backend.vision.model_tasks import planning_progress
from backend.vision.task_memory import context
from backend.vision.task_tools import ApiQuery, prepare
from backend.vision.storage import packed
from test_model_tasks_v2 import response
from test_tasks_v2 import command


def api_turn(index, *, epoch=1, symbol='usd_brep.create_box', runtime='current', empty=False):
    return dict(id='api-'+str(index), epoch=epoch, ordinal=index, revision='revision', state='succeeded',
        response=packed(dict(tool='native_api', arguments={'query':'create_box'})),
        receipt=packed(dict(version='1.0.0', runtime_id=runtime, query='create_box', total_matches=0 if empty else 1,
            entries=[] if empty else [dict(symbol=symbol, kind='function', name=symbol.split('.')[-1], documentation=symbol+'(base, x, y, z) -> Brep\nActual installed doc.' )])))


class ApiLookupTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.workspace, self.tasks = self.app.state.workspace, self.app.state.tasks
        p = self.workspace.create(command('create', name='API test'))
        self.project, self.head = p['project_id'], p['revision_id']
        self.env = patch.dict(os.environ, VISION_MEMORY_SEMANTIC='0')
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.client.close()
        self.folder.cleanup()

    def test_batch_contract_and_no_partial_acceptance(self):
        self.assertEqual(len(ApiQuery(queries=[{'query':'cylinder'},{'query':'boolean'}]).queries), 2)
        for value in ({'query':'x','queries':[{'query':'y'}]}, {'queries':[{'suggest_query':'boolean'}]}, {'queries':[{}]*5}):
            with self.assertRaises(ValueError): ApiQuery.model_validate(value)
        multiple = response('native_api', {'query':'create_box'}, 'call_a')
        multiple['choices'][0]['message']['tool_calls'].append(response('native_api', {'query':'create_cylinder'}, 'call_b')['choices'][0]['message']['tool_calls'][0])
        item, receipt = provider.parse(multiple, 'deepseek-flash')
        self.assertEqual(item['tool'], 'native_api')
        self.assertEqual([v['query'] for v in item['arguments']['queries']], ['create_box','create_cylinder'])
        self.assertEqual(receipt['call_ids'], ['call_a','call_b'])
        self.assertEqual(receipt['usage']['total_tokens'], 15)
        multiple['choices'][0]['message']['tool_calls'][1]['function']['name'] = 'build_geometry'
        with self.assertRaises(provider.MultipleToolCalls): provider.parse(multiple, 'deepseek-flash')
        multiple['choices'][0]['message']['tool_calls'][1]['function']['name'] = 'native_api'
        multiple['choices'][0]['message']['tool_calls'][1]['function']['arguments'] = '{"suggest_query":"boolean"}'
        with self.assertRaises(ValueError): provider.parse(multiple, 'deepseek-flash')

    def test_query_cache_invalidates_with_implementation(self):
        queries = self.app.state.queries
        request = ApiQuery(query='create_box').model_dump()
        with patch('backend.vision.queries.api_identity', return_value='first'), patch.object(queries, 'run', return_value={'entries':[]}) as run:
            self.assertFalse(queries.native_api(request)['cache_hit'])
            self.assertTrue(queries.native_api(request)['cache_hit'])
            self.assertEqual(run.call_count, 1)
        with patch('backend.vision.queries.api_identity', return_value='changed'), patch.object(queries, 'run', return_value={'entries':[]}) as run:
            self.assertFalse(queries.native_api(request)['cache_hit'])
            self.assertEqual(run.call_count, 1)

    def test_build_executes_exact_saved_preflight_without_regenerating_script(self):
        task = dict(id='task',epoch=1,turns=3,revision=self.head)
        original = prepare(task, {'tool':'preview_build','arguments':{'script':'result=u.create_box((0,0,0),1,2,3)','parameters':{'length':3},'use_current':False}}, [])
        preview = dict(epoch=1,revision=self.head,state='succeeded',response=packed({'tool':'preview_build'}),arguments=packed(original),receipt=packed({'digest':'a'*64}))
        built = prepare(task, {'tool':'build_geometry','arguments':{}}, [preview])
        self.assertEqual(built['script'],original['script'])
        self.assertEqual(built['parameters'],original['parameters'])
        self.assertFalse(built['use_current'])
        self.assertEqual(built['expected_impact_digest'],'a'*64)
        with self.assertRaises(ValueError): prepare({**task,'epoch':2},{'tool':'build_geometry','arguments':{}},[preview])
        compiled = dict(epoch=1,revision_id=self.head,project={'geometry':'b'*64},
            cad_api_signatures=[{'symbol':'usd_brep.create_box','signature':'create_box(origin,length,width,height)'}],
            recent_tool_groups=[{'epoch':1,'revision_id':self.head,'instruction':{'tool':'preview_build'}}])
        compiled['project']['modeling_requirements'] = [{'name':'fixture','metric':'solid_count','minimum':1,'source_ids':['fixture']}]
        build = next(tool for tool in provider.payload(compiled,'deepseek-flash')['tools'] if tool['function']['name']=='build_geometry')
        self.assertEqual(build['function']['parameters']['properties'],{})

    def test_reference_deduplicates_and_survives_confirmation_but_not_runtime_change(self):
        created = self.tasks.create(self.project, command('task', expected_head=self.head, statement='自行决定参数后建模', plan=[{'tool':'assessment','arguments':{}}], max_jobs=3))
        task, _ = self.tasks.snapshot(created['task_id'])
        with self.workspace.db() as db:
            row = db.execute('SELECT payload FROM sources WHERE id=?',(task['source'],)).fetchone()
            db.execute('UPDATE sources SET payload=? WHERE id=?',(packed({**json.loads(row[0]), 'conversation':True}),task['source']))
        task['epoch'] = 2
        turns = [api_turn(i) for i in range(40)]
        with patch('backend.vision.queries.api_identity', return_value='current'):
            compiled, metadata = context(self.workspace, task, turns, budget=24000)
        self.assertEqual(len(compiled['cad_api_reference']), 1)
        self.assertEqual(len(compiled['recent_tool_groups']), 2)
        self.assertNotIn('documentation', packed(compiled['recent_tool_groups']))
        self.assertLess(metadata['characters'], 5000)
        with patch('backend.vision.queries.api_identity', return_value='changed'):
            compiled, _ = context(self.workspace, task, turns, budget=24000)
        self.assertEqual(compiled['cad_api_reference'], [])

    def test_watchdog_is_not_an_aggregate_budget(self):
        task = {'epoch':1}
        repeated = [api_turn(i) for i in range(4)]
        self.assertTrue(planning_progress(task, repeated)['recovery_required'])
        distinct = [api_turn(i, symbol='usd_brep.function_'+str(i)) for i in range(6)]
        self.assertFalse(planning_progress(task, distinct)['recovery_required'])
        self.assertTrue(planning_progress(task, distinct)['ready_to_build'])
        for cycle in range(20):
            distinct.append(dict(epoch=1,state='succeeded',response=packed({'tool':'build_geometry'})))
            distinct.extend(api_turn(cycle*10+i,symbol='usd_brep.next_'+str(i)) for i in range(5))
        self.assertTrue(planning_progress(task, distinct)['recovery_required'])
        compiled = {'revision_id':'revision','project':{'geometry':None},'planning_progress':planning_progress(task,repeated)}
        offered = {tool['function']['name'] for tool in provider.payload(compiled,'deepseek-flash')['tools']}
        self.assertEqual(offered, {'ask_user','finish'})
        compiled['cad_api_signatures'] = [{'symbol':'usd_brep.create_box','signature':'create_box(origin,length,width,height)'}]
        offered = {tool['function']['name'] for tool in provider.payload(compiled,'deepseek-flash')['tools']}
        self.assertEqual(offered, {'set_modeling_requirements','ask_user','finish'})
        compiled['project']['modeling_requirements'] = [{'name':'fixture','metric':'solid_count','minimum':1,'source_ids':['fixture']}]
        offered = {tool['function']['name'] for tool in provider.payload(compiled,'deepseek-flash')['tools']}
        self.assertEqual(offered, {'build_geometry','ask_user','finish'})

    def test_unlimited_empty_query_loop_pauses_without_more_network_requests(self):
        with patch('backend.vision.provider.api_key',return_value='test-only'):
            task = self.tasks.create(self.project, command('loop', expected_head=self.head, statement='参数自行决定，直接建模', unlimited=True,max_jobs=3,max_requests=12), model=True)['task_id']
        self.tasks.step(task)
        responses = [response('native_api',{'query':'unknown_'+str(i)},'call_'+str(i)) for i in range(5)]
        with patch('backend.vision.provider.complete',side_effect=responses) as complete, patch('backend.vision.tasks.execute',return_value={'entries':[], 'total_matches':0}) as execute:
            for _ in range(8): self.tasks.step(task)
        result = self.tasks.get(task)
        self.assertEqual(result['state'],'waiting_user')
        self.assertIn('空转',result['error'])
        self.assertEqual(complete.call_count,5)
        self.assertEqual(execute.call_count,3)
        self.assertEqual(result['config']['used_tokens'],75)
        self.assertEqual(result['jobs'],0)


@unittest.skipUnless(os.environ.get('VISION_TEST_NATIVE_CORE')=='1','opt-in installed CAD runtime')
class NativeApiLookupTest(unittest.TestCase):
    def test_relevant_batch_search_and_cache_in_real_runtime(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            app = create_app(folder,run_jobs=False)
            q = app.state.queries
            request = ApiQuery(queries=[{'query':'boolean'},{'query':'create_cylinder'},{'query':'extrude sweep'},{'query':'create_polygon_that_does_not_exist'}]).model_dump()
            result = q.native_api(request)
            self.assertEqual(len(result['lookups']),4)
            boolean, cylinder, alternatives, missing = result['lookups']
            self.assertEqual(boolean['entries'][0]['kind'],'function')
            self.assertEqual(cylinder['entries'][0]['name'],'create_cylinder')
            self.assertTrue(alternatives['entries'])
            self.assertEqual(missing['entries'],[])
            self.assertTrue(missing['suggested_symbols'])
            self.assertIn('usd_brep.create_line_segment', {v['symbol'] for v in result['capability_index']['core_signatures']})
            self.assertFalse(result['capability_index']['complete_catalog'])
            self.assertLess(len(packed(result)),16000)
            self.assertTrue(q.native_api(request)['cache_hit'])
            q.close()


if __name__=='__main__': unittest.main()
