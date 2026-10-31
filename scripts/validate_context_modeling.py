"""Opt-in real DeepSeek + native CAD conversation in a new isolated workspace."""
import argparse
import json
import math
from pathlib import Path
import sys
import subprocess
import time
import types
from unittest.mock import patch
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient
from backend.vision import model_tasks, provider
from backend.vision.api import create_app
from backend.vision.context_content import resolve_content
from backend.vision.storage import identity, packed


STATEMENTS = [
    '建立一个参数化矩形安装板，单一闭合实体，命名 plate。原点为(0,0,0)，X向长度60mm、Y向宽度40mm、Z向厚度6mm。'
    '参数名固定为 length、width、thickness，并通过这些参数重新生成完整板体。请登记来源明确的数值建模要求，以实体数量和实际包围盒校核。'
    '这是建模测试，不做CAE、不设材料载荷、不额外美化；给定条件已授权，完成后简洁结束。',
    '在当前安装板上增加一个Z向贯穿圆孔，圆心全局坐标X=15mm、Y=20mm，直径6mm；保持60×40×6mm和单一实体。'
    '请在现有参数化脚本上修改，保留通过length、width、thickness重新生成完整板体和孔的能力。先预检再构建。'
    '更新数值要求：孔后理论体积14230.354mm³，允许±0.2mm³；尺寸保持不变。不做CAE，完成构建和已有检查后结束，不重复确认。',
    '只将length从60mm改为72mm，width仍为40mm、thickness仍为6mm，孔圆心仍为全局(15,20)、直径6mm。'
    '用现有参数重放，不重写脚本；先预检再构建，更新当前尺寸与体积要求。新理论体积17110.354mm³，允许±0.2mm³。'
    '保留此前的单实体和贯穿孔要求，不做CAE。完成后结束。'
]


def command(**values):
    key = identity()
    return {'command_id': key, 'idempotency_key': key, **values}


def audit(workspace, project, stage):
    revision = workspace.revision(project)
    manifest = workspace.artifacts.manifest(revision['document']['geometry'])
    bodies = manifest['bodies']
    expected_length = 72 if stage == 3 else 60
    expected_volume = expected_length * 40 * 6 - (math.pi * 9 * 6 if stage > 1 else 0)
    bounds = manifest['metrics']['bbox_mm']
    extents = [bounds['max'][i] - bounds['min'][i] for i in range(3)]
    hole_faces = [face for body in bodies for face in body['faces']
        if all(abs(face['bbox_mm'][side][i] - value) < 1e-3
               for side, values in [('min', [12, 17, 0]), ('max', [18, 23, 6])]
               for i, value in enumerate(values)) and abs(face['area_mm2'] - 2 * math.pi * 3 * 6) < .1]
    result = {'revision_id': revision['revision_id'], 'artifact_id': revision['document']['geometry'],
        'solid_count': sum(body['kind'] == 'solid' for body in bodies), 'bbox_extents_mm': extents,
        'volume_mm3': manifest['metrics']['volume_mm3'], 'expected_volume_mm3': expected_volume,
        'hole_boundary_matches': len(hole_faces), 'parameters': manifest['parameters'],
        'script_sha256': manifest['files']['source.py']}
    result['passed'] = (len(bodies) == result['solid_count'] == 1
        and all(abs(a - b) < 1e-3 for a, b in zip(extents, [expected_length, 40, 6]))
        and abs(result['volume_mm3'] - expected_volume) <= .2 and (stage == 1 or bool(hole_faces)))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Make billable model requests using the configured DeepSeek credential.')
    parser.add_argument('--baseline', type=Path, help='Optional baseline source; defaults to the pinned Git commit 212f288.')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/context-modeling-validation.json')
    args = parser.parse_args()
    if not args.live:
        parser.error('--live is required; this uses the real configured model')
    if not provider.status(ROOT / '.vision-workspace')['configured']:
        parser.error('DeepSeek credential is not configured')
    baseline = types.ModuleType('backend.vision.context_baseline')
    baseline.__package__ = 'backend.vision'
    old_source = args.baseline.read_text(encoding='utf-8-sig') if args.baseline else subprocess.run(
        ['git', 'show', '212f288:backend/vision/task_memory.py'], cwd=ROOT, capture_output=True, check=True,
        encoding='utf-8').stdout
    exec(compile(old_source, 'context-baseline-212f288.py', 'exec'), baseline.__dict__)
    folder = ROOT / '.vision-workspace' / ('context-validation-' + identity())
    folder.mkdir(parents=True)
    model = provider.settings(ROOT / '.vision-workspace')
    (folder / 'model-settings.json').write_text(packed({'model': model}), encoding='utf-8')
    report = {'model': model, 'workspace': str(folder), 'method': 'Real model and CAD; paired offline old/new compiler comparison on the same step state. Same request envelope; character/byte ratios are not counterfactual provider tokens.',
              'stages': [], 'requests': []}
    prepare = model_tasks.prepare_request

    def capture(runner, task, turns, config):
        prepared = prepare(runner, task, turns, config)
        current = prepared['compiled']
        resolved = resolve_content(current, current)
        record = {'turn_id': prepared['pending']['id'], 'epoch': task['epoch'], 'ordinal': task['turns'],
                  'context_characters_after': len(packed(current)), 'request_characters_after': len(packed(prepared['request'])),
                  'request_bytes_after': len(packed(prepared['request']).encode()), 'deduplication': prepared['metadata'].get('deduplication'),
                  'contributors': prepared['metadata'].get('contributors'),
                  'truth_document_equal': resolved['project'] == runner.workspace.revision(task['project'], task['revision'])['document'],
                  'statement_preserved': resolved['statement'] == STATEMENTS[task['epoch'] - 1], 'references_resolved': True}
        extra = {key: current[key] for key in ('planning_progress', 'last_tool_rejection') if key in current}
        try:
            before, _ = baseline.context(runner.workspace, task, turns, budget=24000 - len(packed(extra)))
            before.update(extra)
            request = {**prepared['request'], 'messages': [prepared['request']['messages'][0], {'role': 'user', 'content': packed(before)}]}
            record.update(context_characters_before=len(packed(before)), request_characters_before=len(packed(request)),
                          request_bytes_before=len(packed(request).encode()))
        except ValueError as error:
            record['baseline_error'] = str(error)
        report['requests'].append(record)
        print(packed({'request_prepared': len(report['requests']), 'epoch': task['epoch'],
                      'context_characters': len(packed(current)), 'deduplication': prepared['metadata'].get('deduplication')}), flush=True)
        return prepared

    started = time.monotonic()
    task_id, workspace = None, None
    try:
        with patch('backend.vision.model_tasks.prepare_request', side_effect=capture), TestClient(create_app(folder)) as client:
            app = client.app
            workspace = app.state.workspace
            project = workspace.create(command(name='隔离上下文多步验证'))['project_id']
            report['project_id'] = project
            task_id, epoch = None, None
            for index, statement in enumerate(STATEMENTS, 1):
                head = workspace.revision(project)['revision_id']
                response = client.post(f'/api/v2/projects/{project}/conversation', json=command(expected_head=head,
                    expected_task=task_id, expected_epoch=epoch, text=statement, artifact_id=None, selection=[]))
                if response.status_code != 202:
                    raise ValueError(response.text)
                task_id, epoch = response.json()['task_id'], response.json()['epoch']
                until = time.monotonic() + 480
                while time.monotonic() < until:
                    task = app.state.tasks.get(task_id)
                    if task['state'] in ('completed', 'waiting_user', 'cancelled'):
                        break
                    if task['turns'] >= 12 or task['config']['used_tokens'] > 500000:
                        app.state.tasks.change(task_id, command(expected_epoch=epoch))
                        raise ValueError('live validation request/token guard reached')
                    time.sleep(.25)
                else:
                    app.state.tasks.change(task_id, command(expected_epoch=epoch))
                    raise ValueError('live validation stage timed out')
                stage = {'stage': index, 'state': task['state'], 'error': task.get('error'),
                         'model_requests': task['turns'], 'reported_tokens': task['current_epoch_reported_tokens'], 'native_jobs': task['jobs']}
                report['stages'].append(stage)
                if task['state'] != 'completed':
                    raise ValueError(f'stage {index} paused: {task.get("error") or task.get("summary")}')
                stage['geometry'] = audit(workspace, project, index)
                print(packed({'stage_finished': index, **stage}), flush=True)
                if not stage['geometry']['passed']:
                    raise ValueError(f'stage {index} failed independent geometry audit')
            report['parameter_replay_preserved_script'] = report['stages'][1]['geometry']['script_sha256'] == report['stages'][2]['geometry']['script_sha256']
            report['passed'] = report['parameter_replay_preserved_script'] and all(
                r['truth_document_equal'] and r['statement_preserved'] and r['references_resolved'] for r in report['requests'])
    except Exception as error:
        report.update(passed=False, error=str(error))
    finally:
        if task_id and workspace:
            with workspace.db() as db:
                turns = [dict(row) for row in db.execute(
                    'SELECT epoch,ordinal,state,response,error FROM agent_turns WHERE task=? ORDER BY epoch,ordinal', (task_id,))]
            responses = [json.loads(turn['response'] or '{}') for turn in turns]
            usage = [response.get('provider', {}).get('usage', {}) for response in responses]
            report['usage'] = {key: sum(item.get(key, 0) for item in usage) for key in
                ('prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens')}
            report['turns'] = [{**{key: turn[key] for key in ('epoch', 'ordinal', 'state', 'error')},
                                'tool': response.get('tool'), 'usage': response.get('provider', {}).get('usage', {})}
                               for turn, response in zip(turns, responses)]
            report['tool_counts'] = dict(Counter(response.get('tool') for response in responses))
            report['rejected_request_tokens'] = sum(item.get('total_tokens', 0)
                for turn, item in zip(turns, usage) if turn['state'] == 'rejected')
        paired = [record for record in report['requests'] if 'request_characters_before' in record]
        report['comparison'] = {'paired_steps': len(paired),
            'context_characters_before': sum(record['context_characters_before'] for record in paired),
            'context_characters_after': sum(record['context_characters_after'] for record in paired),
            'request_characters_before': sum(record['request_characters_before'] for record in paired),
            'request_characters_after': sum(record['request_characters_after'] for record in paired),
            'deduplication_saved_characters': sum(record['deduplication']['saved_characters'] for record in report['requests']),
            'baseline_uncompilable_steps': len(report['requests']) - len(paired)}
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(packed({'passed': report.get('passed'), 'output': str(args.output), 'error': report.get('error')}), flush=True)
    return 0 if report.get('passed') else 1


if __name__ == '__main__':
    raise SystemExit(main())
