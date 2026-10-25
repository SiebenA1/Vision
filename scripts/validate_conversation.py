"""Opt-in real DeepSeek + native CAD conversation replay, synthetic data only."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision.storage import identity


def command(**fields):
    key = identity()
    return dict(command_id=key, idempotency_key=key, **fields)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    if not args.live:
        parser.error('--live is required; performs paid DeepSeek requests')
    report = {'case': 'persistent-conversation-live', 'rounds': []}
    with tempfile.TemporaryDirectory(prefix='vision-conversation-') as folder:
        with TestClient(create_app(folder)) as client:
            project = client.post('/api/v2/projects', json=command(name='Synthetic conversation replay')).json()
            base = '/api/v2/projects/' + project['project_id']
            prompts = [
                '这是对话回放测试。请记住代号VSN-1024，梁长100mm。现在只用ask_user询问材料，不要建模或求解。',
                '材料为钢，E=210000MPa、泊松比0.3。请用中文总结前面代号和梁长以及本条材料，然后finish。不要建模或求解。',
                '沿用刚才的梁长，宽20mm、高10mm，从原点沿X方向建立实心长方体。只构建几何，不配置工况或求解；成功后finish说明。']
            for index, text in enumerate(prompts):
                current = client.get(base+'/conversation').json()['task']
                head = client.get(base).json()['revision_id']
                sent = client.post(base+'/conversation', json=command(expected_head=head, text=text,
                    expected_task=current['id'] if current else None, expected_epoch=current['epoch'] if current else None))
                assert sent.status_code == 202, sent.text
                until = time.monotonic()+180
                while True:
                    value = client.get(base+'/conversation').json()
                    task = value['task']
                    if task['state'] not in ('created','executing','waiting_job'):
                        break
                    if time.monotonic()>until:
                        client.post('/api/v2/tasks/'+task['id']+'/cancel',json=command(expected_epoch=task['epoch']))
                        raise RuntimeError('test timeout; task stopped')
                    time.sleep(.2)
                report['rounds'].append({'state':task['state'],'requests':task['turns'],'jobs':task['jobs'],'error':task['error'],
                                        'messages':len(value['messages']),'used_tokens':task['config']['used_tokens'],
                                        'tools':[s['response']['tool'] for s in task['steps'] if s['epoch']==task['epoch'] and s['response']]})
                assert not task['error'], report
                assert task['state']==('waiting_user' if index==0 else 'completed'), report
                if index==1:
                    answer=value['messages'][-1]['text']
                    assert 'VSN-1024' in answer and '100' in answer, answer
            geometry=client.get(base).json()['document']['geometry']
            assert geometry, report
            # Native topology -> selected object -> next real model request.
            manifest=client.get('/api/v2/artifacts/'+geometry+'/manifest').json()
            face=manifest['bodies'][0]['faces'][0]['id']
            task=value['task']
            sent=client.post(base+'/conversation',json=command(expected_head=client.get(base).json()['revision_id'],
                expected_task=task['id'],expected_epoch=task['epoch'],artifact_id=geometry,selection=[face],
                text='我引用了一个面。只确认收到此对象引用并finish，不修改几何或工况，也不求解。'))
            assert sent.status_code==202,sent.text
            until=time.monotonic()+90
            while time.monotonic()<until:
                value=client.get(base+'/conversation').json()
                if value['task']['state'] not in ('created','executing','waiting_job'): break
                time.sleep(.2)
            assert value['task']['state']=='completed',value['task']['error']
            report['selection_verified']=True
            report['messages']=len(value['messages'])
            report['used_tokens']=value['task']['config']['used_tokens']
            report['passed']=True
    output=Path('screenshots')/f'conversation-live-{int(time.time())}.json'
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    print(output.resolve())


if __name__=='__main__':
    main()
