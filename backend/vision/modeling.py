"""Current-artifact checks for explicitly registered modeling requirements."""
import json
import math

from .contracts import SetModelingRequirements, ModelingRequirement
from .engineering_memory import available, context_eligible
from .storage import Conflict, packed
from .validation import validate_cad


class CompletionError(ValueError):
    pass


def body_metrics(body):
    """Measured artifact values, without face/edge pagination or mesh arrays."""
    return {key: body[key] for key in ('id', 'name', 'kind', 'manifold', 'bbox_mm', 'volume_mm3', 'area_mm2') if key in body} | {
        'entity_kind':'body', 'face_count': len(body.get('faces', [])), 'edge_count': len(body.get('edges', []))}


def geometry_summary(manifest, budget=3500):
    """Bounded evidence for verification; bbox relations are not clearance tests."""
    bodies = []
    for body in manifest.get('bodies', [])[:8]:
        levels = {axis:set() for axis in 'xyz'}
        for face in body.get('faces', []):
            box = face.get('bbox_mm') or {}
            if not box.get('min') or not box.get('max'):
                continue
            for i, axis in enumerate('xyz'):
                if box['max'][i] - box['min'][i] <= .0001:
                    levels[axis].add(round((box['min'][i] + box['max'][i])/2, 6))
        bodies.append({**body_metrics(body),
                       'bbox_inferred_face_levels_mm': {axis:sorted(values)[:8] for axis,values in levels.items()},
                       'face_levels_truncated': any(len(values) > 8 for values in levels.values())})
    result = {'artifact_id':manifest.get('artifactId'), 'bodies':bodies, 'body_count':len(manifest.get('bodies', [])),
              'scope':'Measured body metrics and bbox-inferred face levels; not proof of wall thickness, fit, clearance or topology continuity.'}
    if len(bodies) == 2:
        a, b = bodies
        result['bbox_relation'] = {'a':a['id'], 'b':b['id'], 'axis_gaps_mm':{
            axis:max(0, b['bbox_mm']['min'][i]-a['bbox_mm']['max'][i],
                     a['bbox_mm']['min'][i]-b['bbox_mm']['max'][i]) for i,axis in enumerate('xyz')}}
    while len(packed(result)) > budget and result['bodies']:
        result['bodies'].pop()
        result.pop('bbox_relation', None)
    result['bodies_truncated'] = len(result['bodies']) < result['body_count']
    return result


def set_requirements(workspace, project, request, fence=None):
    request = SetModelingRequirements.model_validate(request).model_dump()
    def change(db):
        revision = workspace._revision(db, project)
        document = revision['document']
        rows = {row['id']: json.loads(row['payload']) for row in db.execute('SELECT id,payload FROM sources WHERE project=?', (project,))}
        for item in request['requirements']:
            if any(not available(rows, source) or not context_eligible(rows, source, revision) for source in item['source_ids']):
                raise ValueError('modeling requirement source is unavailable or no longer applicable in this project')
        plan = request['components'] if request['components'] is not None else document.get('modeling_plan', [])
        if document.get('modeling_requirements') == request['requirements'] and document.get('modeling_plan', []) == plan:
            return revision
        return workspace._commit(db, project, revision['revision_id'], {**document, 'modeling_requirements': request['requirements'], 'modeling_plan':plan})
    return workspace.command(project, request, change, fence=fence)


def assess_geometry(workspace, project, revision_id=None):
    with workspace.db() as db:
        revision = workspace._revision(db, project, revision_id)
        rows = {row['id']: json.loads(row['payload']) for row in db.execute('SELECT id,payload FROM sources WHERE project=?', (project,))}
        matching_jobs = [json.loads(row[0]) for row in db.execute("SELECT result FROM jobs WHERE project=? AND kind='cad' AND state='succeeded' "
            "AND json_extract(result,'$.artifact_id')=?", (project, revision['document'].get('geometry')))]
    document = revision['document']
    geometry = document.get('geometry')
    requirements = [ModelingRequirement.model_validate(item).model_dump() for item in document.get('modeling_requirements', [])]
    imported_metrics = (all(job.get('origin') == 'imported' for job in matching_jobs) if matching_jobs
                        else bool(document.get('legacy_source')) or any(value.get('origin') == 'imported_source' for value in rows.values()))
    values = {}
    if geometry:
        manifest = workspace.artifacts.manifest(geometry)
        if manifest.get('kind') != 'cad':
            raise ValueError('modeling checks require a CAD artifact')
        validate_cad(manifest)
        bounds = manifest['metrics']['bbox_mm']
        values = {'body_count': len(manifest['bodies']), 'solid_count': sum(body['kind'] == 'solid' for body in manifest['bodies']),
                  'volume_mm3': manifest['metrics']['volume_mm3']}
        # Compare actual extents, rather than a script parameter or a body name.
        values.update({f'bbox_{axis}_mm': bounds['max'][index] - bounds['min'][index] for index, axis in enumerate('xyz')})
    checks, source_ids = [], set()
    for item in requirements:
        source_ids.update(source for source in item['source_ids'] if available(rows, source))
        valid_sources = all(available(rows, source) and context_eligible(rows, source, revision) for source in item['source_ids'])
        actual = values.get(item['metric'])
        status, reason = 'unknown', '该特征需要人工或专门的几何检查'
        if not valid_sources:
            reason = '要求来源已遗忘、停用、替代或失效'
        elif not geometry:
            reason = '当前尚无几何模型'
        elif imported_metrics:
            reason = '导入几何的指标尚未在本机重建核验'
        elif item['metric'] != 'manual' and type(actual) in (int, float) and math.isfinite(actual):
            passed = ((item['minimum'] is None or actual >= item['minimum'])
                      and (item['maximum'] is None or actual <= item['maximum']))
            status, reason = ('pass' if passed else 'fail'), '比较当前几何制品的实测指标'
        checks.append({'requirement': {key: value for key, value in item.items() if key != 'source_ids'},
                       'actual': actual, 'status': status, 'reason': reason})
    status = ('not_built' if not geometry else 'unverified' if not checks else
              'failed' if any(check['status'] == 'fail' for check in checks) else
              'needs_review' if any(check['status'] == 'unknown' for check in checks) else 'checks_passed')
    return {'revision_id': revision['revision_id'], 'artifact_id': geometry, 'status': status,
            'checks': checks, 'source_ids': sorted(source_ids),
            'scope': 'registered_modeling_requirements_only',
            'notice': '只核验已登记的建模检查项；不证明遗漏特征、视觉形态、装配关系或结构安全。'}


def completion(workspace, task, arguments):
    result = assess_geometry(workspace, task['project'], task['revision'])
    with workspace.db() as db:
        if workspace._revision(db, task['project'])['revision_id'] != task['revision']:
            raise Conflict('project changed before completion; review the current geometry')
        latest = db.execute("SELECT state,receipt FROM agent_turns WHERE task=? AND epoch=? "
                            "AND json_extract(response,'$.tool')='build_geometry' ORDER BY ordinal DESC LIMIT 1",
                            (task['id'], task['epoch'])).fetchone()
    if latest and latest['state'] != 'succeeded':
        result['status'] = 'build_failed'
        result['notice'] = '最近建模尝试没有成功完成；现有几何及旧检查不能证明这次修改已完成。'
    outcome = arguments['outcome']
    if outcome in ('built', 'partial', 'verified') and not result['artifact_id']:
        raise CompletionError('当前没有几何模型，不能报告已构建或验收通过；请构建模型或如实结束答复。')
    if outcome == 'built' and result['status'] == 'build_failed':
        raise CompletionError('最近一次构建失败，不能将旧模型报告为本次修改已完成。')
    if outcome == 'verified' and result['status'] != 'checks_passed':
        raise CompletionError('当前建模检查尚未通过，不能报告验收通过；请修正模型、检查要求或报告部分实现。')
    return {**result, 'outcome': outcome}
