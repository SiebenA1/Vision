"""Reproducible local CAD acceptance; isolated project, no remote LLM requests."""
import json
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from test_code_modules_v2 import CodeModuleTest
from backend.vision import code_modules
from backend.vision.storage import packed


def main():
    fixture=CodeModuleTest();fixture.setUp()
    try:
        number=lambda value:{'type':'number','default':value,'unit':'mm','minimum':.1}
        body=fixture.register('box_body',
            'p=parameters\nouter=u.create_box((0,0,0),p["width"],p["depth"],p["height"])\n'
            'inner=u.create_box((3,3,3),p["width"]-6,p["depth"]-6,p["height"])\nresult=u.boolean_difference(outer,inner)',
            parameters={key:number(value) for key,value in {'width':120,'depth':80,'height':40}.items()})
        lid=fixture.register('lid',
            'p=parameters\nresult=u.create_box((0,0,0),p["width"],p["depth"],3)',
            parameters={'width':number(120),'depth':number(80)})
        ref=lambda parameter,offset=0:{'component_id':'body','parameter':parameter,'offset':offset}
        assembly=[{'component_id':'body','module_id':'box_body','code_revision':body['code_revision'],'requirement_ids':['R1']},
                  {'component_id':'lid','module_id':'lid','code_revision':lid['code_revision'],
                   'parameters':{'width':ref('width'),'depth':ref('depth')},'translation':[0,0,ref('height',30)]}]
        rows=[]
        def build(label,**options):
            start=time.perf_counter();manifest,result=fixture.build(assembly,**options)
            row={'case':label,'wall_seconds':round(time.perf_counter()-start,3),
                 **result['module_rebuild'],'mesh_reused':result['module_mesh_reused'],
                 'body_count':len(manifest['bodies']),
                 'body_height_mm':manifest['bodies'][0]['bbox_mm']['size'][2],
                 'lid_min_z_mm':manifest['bodies'][1]['bbox_mm']['min'][2]}
            rows.append(row);return row
        first=build('initial')
        assert first['rebuilt']==['body','lid']
        assembly[0]['parameters']={'height':50}
        changed=build('body_height_40_to_50')
        assert changed['rebuilt']==['body'] and changed['reused']==['lid'] and changed['mesh_reused']==['lid']
        assert abs(changed['body_height_mm']-50)<.001 and abs(changed['lid_min_z_mm']-80)<.001
        assembly[1]['rotation_deg']=[0,0,90]
        pose=build('lid_rotation_only')
        assert pose['rebuilt']==[] and pose['mesh_reused']==['body','lid']
        precision=build('mesh_tolerance_change',tolerance_mm=.01)
        assert precision['rebuilt']==[] and precision['mesh_reused']==[]
        found=code_modules.search(fixture.ws,fixture.project,{'query':'box','limit':4})
        assert 'u.create_box' not in packed(found)
        report={'schema':'vision.code-channel-acceptance/1','remote_model_requests':0,
                'scope':'Actual local CAD geometry and mesh; not visual or mechanical feature certification',
                'cases':rows,'search_payload_characters':len(packed(found)),
                'source_code_in_search':False,'status':'passed'}
        target=ROOT/'docs/code-channel-acceptance.json'
        target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))
    finally:fixture.tearDown()


if __name__=='__main__':main()
