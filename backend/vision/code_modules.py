"""Project-scoped, immutable Python modules and incremental CAD assembly plans."""
import hashlib
import ast
import copy
import json
import math
import re
import tempfile
import time
from contextlib import nullcontext
from pathlib import Path

from .contracts import RegisterCodeModule, CodeInstance, CodeParameter
from .engineering_memory import available, context_eligible, lineage
from .storage import Conflict, Missing, packed


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def compatibility_id():
    from .runtime import profile
    return digest({'contract':'python312-brep-local-mm/1','packages':profile('cad')['packages']})


def is_module(value):
    return value.get('origin') == 'code_module' or value.get('original_origin') == 'code_module'


def eligible(rows,source,current):
    return available(rows,source) and all(context_eligible(rows,key,current) for key in lineage(rows,[source]))


def records(workspace, project, db):
    workspace._revision(db, project)
    return {r['id']:json.loads(r['payload']) for r in db.execute('SELECT id,payload FROM sources WHERE project=? ORDER BY created,id',(project,))}


def lookup(workspace, project, module_id, revision, db):
    rows = records(workspace, project, db)
    current = workspace._revision(db, project)
    for source, value in reversed(list(rows.items())):
        if (is_module(value) and value.get('module_id') == module_id and value.get('code_revision') == revision
                and eligible(rows,source,current)):
            manifest=workspace.artifacts.manifest(revision)
            if manifest.get('kind') != 'code_module' or manifest.get('module_id') != module_id or manifest.get('project') != project:
                raise ValueError('module artifact does not match this project and module')
            if manifest['runtime_id'] != compatibility_id():
                raise Conflict('module runtime is incompatible; register and validate a new version')
            return source,value,manifest
    raise Missing('module version is unavailable in this project or its sources are inactive')


def validate_parameters(schema, values):
    if set(values)-set(schema):
        raise ValueError('unknown module parameter: '+','.join(sorted(set(values)-set(schema))))
    result={}
    for name, raw in schema.items():
        spec=CodeParameter.model_validate(raw).model_dump()
        value=values.get(name,spec['default'])
        kind=spec['type']
        valid=(kind=='number' and type(value) in (int,float) or kind=='integer' and type(value) is int
               or kind=='boolean' and type(value) is bool or kind=='string' and isinstance(value,str))
        if not valid or type(value) in (int,float) and not math.isfinite(value):
            raise ValueError('invalid parameter type: '+name)
        if type(value) in (int,float) and (spec['minimum'] is not None and value<spec['minimum'] or spec['maximum'] is not None and value>spec['maximum']):
            raise ValueError('module parameter is out of bounds: '+name)
        result[name]=float(value) if kind=='number' else value
    return result


def register(workspace, project, request, fence=None, receipt_request=None):
    from .task_tools import validate_box_calls,validate_boolean_reuse
    request=RegisterCodeModule.model_validate(request).model_dump()
    try:ast.parse(request['script'],feature_version=(3,12))
    except SyntaxError as error:raise ValueError('module source must use native Python 3.12 syntax: '+str(error)) from None
    validate_box_calls(request['script']);validate_boolean_reuse(request['script'])
    validate_parameters(request['parameters'],{})
    metadata={key:request[key] for key in ('module_id','description','parameters','tags')}
    metadata.update(kind='code_module',schema='vision.code-module/1',project=project,runtime_id=compatibility_id(),
                    output_contract='One Brep in result; mm and local coordinates; declared dependency parts are independent copies.')
    with tempfile.TemporaryDirectory(prefix='code-',dir=workspace.root) as folder:
        Path(folder,'module.py').write_text(request['script'],encoding='utf-8')
        artifact=workspace.artifacts.publish(folder,['module.py'],metadata)
    def action(db):
        rows=records(workspace,project,db);current=workspace._revision(db,project)
        dependencies=set(request['source_ids'])|{b['source_id'] for b in request['bindings']}
        if any(key not in rows or not available(rows,key) or not context_eligible(rows,key,current) for key in dependencies):
            raise ValueError('module sources must be active and belong to the current project')
        payload={'origin':'code_module','module_id':request['module_id'],'code_revision':artifact['artifactId'],
                 'text':request['description']+' '+ ' '.join(request['tags']), 'status':'active',
                 'bindings':request['bindings'],'derived_from':sorted(dependencies)}
        source=digest({'project':project,**payload})
        db.execute('INSERT OR IGNORE INTO sources VALUES(?,?,?,?)',(source,project,packed(payload),time.time()))
        return {'module_id':request['module_id'],'code_revision':artifact['artifactId'],'source_ids':[source],
                'bindings':request['bindings'],'validation':'syntax_checked_not_geometry_verified'}
    return workspace.command(project,receipt_request or request,action,fence=fence)


def read(workspace,project,request):
    with workspace.db() as db:
        source,value,manifest=lookup(workspace,project,request['module_id'],request['code_revision'],db)
    text=workspace.artifacts.file(request['code_revision'],'module.py').read_text(encoding='utf-8')
    offset,limit=request.get('offset',0),request.get('limit',2000)
    return {'module_id':request['module_id'],'code_revision':request['code_revision'],'text':text[offset:offset+limit],
            'offset':offset,'total_characters':len(text),'truncated':offset>0 or offset+limit<len(text),
            'source_ids':[source],'parameters':manifest['parameters'],'bindings':value['bindings']}


def read_assembly(workspace,project,request):
    geometry=workspace.revision(project)['document'].get('geometry')
    if not geometry:raise Missing('no current module assembly')
    execution=workspace.artifacts.manifest(geometry).get('module_execution',{})
    components=execution.get('components',[])
    if request.get('component_id'):
        components=[item for item in components if item['component_id']==request['component_id']]
    selected=components[request.get('offset',0):request.get('offset',0)+request.get('limit',4)]
    with workspace.db() as db:
        sources=[lookup(workspace,project,item['module_id'],item['code_revision'],db)[0] for item in selected]
    return {'artifact_id':geometry,'components':[item['definition'] for item in selected],
            'total_components':len(components),'source_ids':list(dict.fromkeys(sources))}


def edit_assembly(workspace,project,revision,base,edits):
    from .task_tools import AssemblyEdit
    geometry=workspace.revision(project,revision)['document'].get('geometry')
    if not geometry or base!=geometry:raise Conflict('assembly edit base is not the current geometry artifact')
    execution=workspace.artifacts.manifest(geometry).get('module_execution',{})
    plan=[copy.deepcopy(item['definition']) for item in execution.get('components',[])]
    if not plan:raise Missing('current geometry has no module assembly plan')
    if not isinstance(edits,list) or not 1<=len(edits)<=24:raise ValueError('assembly_edits needs 1 to 24 component changes')
    known={item['component_id']:item for item in plan};seen=set()
    for raw in edits:
        edit=AssemblyEdit.model_validate(raw).model_dump(exclude_none=True);name=edit.pop('component_id')
        if name not in known or name in seen:raise ValueError('unknown or duplicate edited component')
        seen.add(name)
        if 'parameters' in edit:edit['parameters']={**known[name]['parameters'],**edit['parameters']}
        known[name].update(edit)
    return plan


def patch_module(workspace,project,request,fence=None):
    with workspace.db() as db:
        base_source,value,manifest=lookup(workspace,project,request['module_id'],request['code_revision'],db)
    script=workspace.artifacts.file(request['code_revision'],'module.py').read_text(encoding='utf-8')
    for edit in request['script_edits']:
        if script.count(edit['old_text'])!=1:raise Conflict('module patch target is absent or ambiguous at this version')
        script=script.replace(edit['old_text'],edit['new_text'],1)
    new={key:manifest[key] for key in ('module_id','description','parameters','tags')}
    new.update({key:request[key] for key in ('command_id','idempotency_key','expected_head','source_ids')},
               script=script,bindings=value['bindings'])
    new['source_ids']=list(dict.fromkeys([*request['source_ids'],base_source]))
    return register(workspace,project,new,fence,receipt_request=request)


def search(workspace,project,request):
    from .queries import api_identity
    runtime=compatibility_id();items=[];seen=set()
    with workspace.db() as db:
        rows=records(workspace,project,db);current=workspace._revision(db,project)
        tested=set();execution_runtime=api_identity()
        for row in db.execute("SELECT json_extract(input,'$.command._module_execution') FROM jobs WHERE project=? AND kind='cad' AND state='succeeded' AND coalesce(json_extract(result,'$.origin'),'local')!='imported'",(project,)):
            execution=json.loads(row[0] or '{}')
            if execution.get('runtime_id')==execution_runtime:
                tested.update((item['module_id'],item['code_revision']) for item in execution.get('components',[]) if not item['reused'])
        for source,value in reversed(list(rows.items())):
            if not is_module(value) or not eligible(rows,source,current):
                continue
            key=value['module_id']
            if key in seen:continue
            seen.add(key);manifest=workspace.artifacts.manifest(value['code_revision'])
            if manifest.get('runtime_id')!=runtime:continue
            if not set(request.get('tags',[]))<=set(manifest['tags']) or not set(request.get('parameter_names',[]))<=set(manifest['parameters']):continue
            text=(manifest['module_id']+' '+value['text']).casefold()
            terms=re.findall(r'\w+',request.get('query','').casefold())
            score=sum(term in text for term in terms)
            items.append({'module_id':value['module_id'],'code_revision':value['code_revision'],
                          'description':manifest['description'],'parameters':manifest['parameters'],'tags':manifest['tags'],
                          'bindings':value['bindings'],'source_ids':[source],'score':score,
                          'validation':'executed_geometry_not_full_feature_verified' if (value['module_id'],value['code_revision']) in tested else 'syntax_checked_not_geometry_verified'})
    items.sort(key=lambda item:(-item['score'],item['validation']!='executed_geometry_not_full_feature_verified'))
    method='structured_lexical'
    if request.get('semantic') and request.get('query') and items:
        try:
            from .retrieval import models
            _,ranker=models()
            scores=list(ranker.rerank(request['query'],[item['description'] for item in items[:32]],batch_size=4))
            candidates=items[:32]
            items=[item for _,item in sorted(zip(scores,candidates),key=lambda pair:-float(pair[0]))]+items[32:]
            method='structured_lexical_local_rerank'
        except (ImportError,ValueError,RuntimeError,OSError):
            method='structured_lexical_semantic_unavailable'
    chosen=items[:request.get('limit',4)]
    while len(packed(chosen))>14000 and chosen:chosen.pop()
    return {'modules':chosen,'total_matches':len(items),'omitted_modules':len(items)-len(chosen),'method':method,
            'source_ids':list(dict.fromkeys(s for item in chosen for s in item['source_ids']))}


def resolve(workspace,project,document,instances,use_current=True,db=None):
    """Materialize exact code references and reuse current proven local geometry."""
    from .queries import api_identity
    runtime=api_identity();resolved=[];known={};source_ids=set();old={};local_files={}
    with nullcontext(db) if db is not None else workspace.db() as connection:
        if use_current and document.get('geometry'):
            jobs=[json.loads(r[0]) for r in connection.execute("SELECT result FROM jobs WHERE project=? AND kind='cad' AND state='succeeded' AND json_extract(result,'$.artifact_id')=?",(project,document['geometry']))]
            if any(job.get('origin')!='imported' for job in jobs):
                previous=workspace.artifacts.manifest(document['geometry'])
                old={item['component_id']:item for item in previous.get('module_execution',{}).get('components',[])}
                local_files=previous.get('module_files',{})
        for raw in instances:
            item=CodeInstance.model_validate(raw).model_dump();name=item['component_id']
            if name in known or any(dep not in known for dep in item['depends_on']):
                raise ValueError('component IDs must be unique and geometry dependencies must precede each component')
            source,value,manifest=lookup(workspace,project,item['module_id'],item['code_revision'],connection)
            source_ids.add(source)
            if not set(item['requirement_ids'])<={binding['requirement_id'] for binding in value['bindings']}:
                raise ValueError('component requirement IDs must map to registered module bindings')
            def scalar(value,unit=None):
                if not isinstance(value,dict):return value
                ref=known.get(value['component_id'])
                if ref is None or value['parameter'] not in ref['parameters']:
                    raise ValueError('parameter binding must refer to an earlier component parameter')
                base=ref['parameters'][value['parameter']]
                if type(base) not in (int,float):raise ValueError('linear bindings require numeric parameters')
                source_unit=ref['parameter_units'][value['parameter']]
                if unit is not None and source_unit!=unit:raise ValueError('parameter binding units must match')
                if value['scale']==1 and value['offset']==0:return base
                return base*value['scale']+value['offset']
            parameters=validate_parameters(manifest['parameters'],{key:scalar(v,manifest['parameters'].get(key,{}).get('unit')) for key,v in item['parameters'].items()})
            key=digest({'code_revision':item['code_revision'],'runtime':runtime,'parameters':parameters,
                        'geometry_dependencies':{dep:known[dep]['geometry_key'] for dep in item['depends_on']}})
            translation=[scalar(v,'mm') for v in item['translation']]
            if any(type(v) not in (int,float) or not math.isfinite(v) for v in translation):raise ValueError('invalid component placement')
            cached=old.get(name)
            reuse=bool(cached and cached.get('geometry_key')==key)
            spec={**item,'definition':item,'parameters':parameters,'translation':translation,'geometry_key':key,'reused':reuse,
                  'parameter_units':{key:value['unit'] for key,value in manifest['parameters'].items()},
                  'old_translation':cached['translation'] if reuse and name not in local_files else [0,0,0],
                  'old_rotation_deg':cached['rotation_deg'] if reuse and name not in local_files else [0,0,0]}
            known[name]=spec;resolved.append(spec)
    programs={item['code_revision']:workspace.artifacts.file(item['code_revision'],'module.py').read_text(encoding='utf-8')
              for item in resolved if not item['reused']}
    # Runtime handles never cross workers. Dependencies are copied before a
    # module can consume them, and placement is separate from local geometry.
    script=('import json\n__specs=json.loads('+repr(packed(resolved))+')\n__programs=json.loads('+repr(packed(programs))+')\n')+'''__local={}
__axes=((1,0,0),(0,1,0),(0,0,1))
for __s in __specs:
    __id=__s['component_id']
    if __s['reused']:
        __b=parts[__id].copy()
        u.translate(__b,tuple(-v for v in __s['old_translation']))
        for __i in (2,1,0):
            if __s['old_rotation_deg'][__i]:u.rotate(__b,(0,0,0),__axes[__i],-__s['old_rotation_deg'][__i])
    else:
        __p=dict(__s['parameters'])
        __ns={'u':u,'parameters':__p,'params':__p,'parts':{d:__local[d].copy() for d in __s['depends_on']}}
        try:
            exec(compile(__programs[__s['code_revision']],'<module:'+__id+'@'+__s['code_revision']+'>','exec'),__ns,__ns)
        except Exception as __error:
            raise RuntimeError('module '+__id+'@'+__s['code_revision']+': '+str(__error)) from __error
        __b=__ns.get('result')
        if not isinstance(__b,u.Brep):raise ValueError('module must return one Brep in result')
    __local[__id]=__b
result={}
for __s in __specs:
    __b=__local[__s['component_id']].copy()
    for __i in (0,1,2):
        if __s['rotation_deg'][__i]:u.rotate(__b,(0,0,0),__axes[__i],__s['rotation_deg'][__i])
    u.translate(__b,tuple(__s['translation']))
    result[__s['component_id']]=__b
'''
    if len(script)>200000:raise ValueError('assembly program exceeds the bounded build allowance; split the assembly')
    metadata={'runtime_id':runtime,'components':resolved,'source_ids':sorted(source_ids),
              'rebuilt':[x['component_id'] for x in resolved if not x['reused']],
              'reused':[x['component_id'] for x in resolved if x['reused']]}
    return script,metadata
