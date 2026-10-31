"""Typed local task tools. All project writes use the existing fenced command path."""
import json
import ast
from functools import lru_cache
from dataclasses import dataclass
from types import MappingProxyType
from typing import Callable

from pydantic import Field, model_validator
from typing import Annotated, Literal
from .contracts import Build, ConfigureStudy, Contract, InspectGeometry, Pick, Solve, TopologyId, Remember, Identity, BeamReference, SetModelingRequirements
from .changes import preview_build
from .assessment import assess
from .studies import configure_study
from .task_memory import search
from .storage import packed
from .contracts import RegisterCodeModule, SearchCodeModules, ReadCodeModule, Edit, Digest, CodeParameterRef, CodeValue, Vector
from .read_batch import ReadBatch, execute_batch, prepare_calls


class CadScriptError(ValueError):
    pass


def analysis_receipt(job, reused=False):
    """Give the planner numerical evidence, not thousands of viewport marker coordinates."""
    summary = dict((job.get('result') or {}).get('summary') or {})
    summary['boundaries'] = [{key: item[key] for key in ('id', 'kind', 'name', 'nodes', 'facets', 'areaMm2', 'force') if key in item}
                             for item in summary.get('boundaries', [])]
    return {'job': {key: job.get(key) for key in ('id', 'kind', 'state', 'revision', 'error')} |
                   {'result': {'artifact_id': (job.get('result') or {}).get('artifact_id'), 'summary': summary}},
            'origin': 'verified_tool_receipt', 'reused': reused,
            'next_action': 'Read assessment once and finish with these results. Do not solve unchanged inputs again. Refine only for a stated accuracy comparison.'}


def validate_box_calls(script):
    """Reject an unsupported two-corner overload before admitting a CAD job."""
    try:
        tree = ast.parse(script)
    except SyntaxError as error:
        raise CadScriptError(f"建模脚本第 {error.lineno} 行语法错误：{error.msg}") from None
    aliases = {"u", "usd_brep"}
    aliases.update(alias.asname or alias.name for node in ast.walk(tree) if isinstance(node, ast.Import)
                   for alias in node.names if alias.name == "usd_brep")
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id in aliases
                and node.func.attr == "create_box"):
            continue
        if any(isinstance(arg, ast.Starred) for arg in node.args) or any(k.arg is None for k in node.keywords):
            continue  # Dynamic expansion remains the native runtime's responsibility.
        names = ("origin", "length", "width", "height")
        supplied = list(names[:len(node.args)]) + [k.arg for k in node.keywords]
        if len(node.args) > 4 or len(supplied) != len(set(supplied)) or set(supplied) != set(names):
            raise CadScriptError(f"第 {node.lineno} 行 create_box 参数错误。实际签名为 create_box(origin, length, width, height)，"
                                 "不接受两个角点；如需从两角点建盒体，请显式计算三个坐标差作为长宽高，并修正脚本后重新预览。")


def validate_boolean_reuse(script):
    """Catch straight-line reuse of consumed native handles, including in loops."""
    tree = ast.parse(script)
    operations = {'boolean_difference', 'boolean_union', 'boolean_intersection'}
    aliases = {node.targets[0].id for node in ast.walk(tree)
               if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
               and isinstance(node.value, ast.Attribute) and isinstance(node.value.value, ast.Name)
               and node.value.value.id in {'u', 'usd_brep'} and node.value.attr in operations}
    for block in ast.walk(tree):
        body = getattr(block, 'body', None)
        if not isinstance(body, list):
            continue
        consumed = set()
        for statement in body:
            if not isinstance(statement, (ast.Assign, ast.Expr)):
                consumed.clear()  # Control flow and dynamic bindings are not inferred here.
                continue
            call = statement.value
            if isinstance(call, ast.Call):
                function = call.func
                boolean = ((isinstance(function, ast.Name) and function.id in aliases) or
                           (isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name)
                            and function.value.id in {'u', 'usd_brep'} and function.attr in operations))
                if boolean:
                    handles = [value.id for value in [*call.args, *(k.value for k in call.keywords)] if isinstance(value, ast.Name)]
                    reused = consumed.intersection(handles)
                    if reused:
                        raise CadScriptError(f"第 {call.lineno} 行复用了布尔运算已消耗的对象 {', '.join(sorted(reused))}；"
                                             "布尔运算消耗两个输入，需要在第一次使用时传入 cutter.copy()，或为每次运算创建新切割体。")
                    consumed.update(handles)
            if isinstance(statement, ast.Assign):
                for target in statement.targets:
                    if isinstance(target, ast.Name):
                        consumed.discard(target.id)


class Query(Contract):
    query: str = Field(min_length=1, max_length=2000)


class Question(Contract):
    question: str = Field(min_length=1, max_length=2000)


class ScriptRange(Contract):
    offset: int = Field(default=0, ge=0, le=200000)
    limit: int = Field(default=8000, ge=1, le=8000)


class SourceRange(ScriptRange):
    source_id: Identity


class ToolResultRange(ScriptRange):
    turn_id: Identity


class Selection(Contract):
    selection: list[TopologyId] = Field(default_factory=list, max_length=64)
    pick: Pick | None = None

    @model_validator(mode="after")
    def explicit_query(self):
        if not self.selection and self.pick is None:
            raise ValueError("inspect_geometry requires explicit native IDs or a pick point; use list_topology to discover IDs")
        return self


class AnalysisContext(Contract):
    body_ids: list[Annotated[str, Field(pattern=r"^body-[0-9]+$")]] | None = Field(default=None, min_length=1, max_length=64)
    offset: int = Field(default=0, ge=0, le=1000000)
    limit: int = Field(default=24, ge=1, le=48)


class TopologyPage(Contract):
    query: str = Field(default="", max_length=200)
    offset: int = Field(default=0, ge=0, le=1000000)
    limit: int = Field(default=8, ge=1, le=16)


class ApiLookup(Contract):
    query: str = Field(default="", max_length=200)
    offset: int = Field(default=0, ge=0, le=20000)
    limit: int = Field(default=4, ge=1, le=6)


class ApiQuery(ApiLookup):
    queries: list[ApiLookup] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def one_format(self):
        if self.queries and (self.query or self.offset or self.limit != 4):
            raise ValueError("use either query/offset/limit or queries, not both")
        return self


class Finish(Contract):
    summary: str = Field(min_length=1, max_length=4000)
    outcome: Literal['answer', 'built', 'partial', 'verified']


class ScriptEdit(Contract):
    old_text: str = Field(min_length=1, max_length=8000)
    new_text: str = Field(max_length=8000)


class PatchCodeModule(Edit):
    module_id: Identity
    code_revision: Digest
    script_edits: list[ScriptEdit] = Field(min_length=1,max_length=8)
    source_ids: list[Identity] = Field(min_length=1,max_length=16)


class AssemblyEdit(Contract):
    component_id: Identity
    parameters: dict[str,CodeValue | CodeParameterRef] | None = Field(default=None,max_length=24)
    translation: list[float | int | CodeParameterRef] | None = Field(default=None,min_length=3,max_length=3)
    rotation_deg: Vector | None = None
    code_revision: Digest | None = None


class ReadCodeAssembly(Contract):
    component_id: Identity | None = None
    offset: int = Field(default=0,ge=0,le=24)
    limit: int = Field(default=4,ge=1,le=8)


_PARAMETER_MODELS = {'read_batch': ReadBatch, "preview_build": Build, "build_geometry": Build, "configure_study": ConfigureStudy,
    "solve": Solve, "assessment": Contract, "analysis_context": AnalysisContext, "beam_reference": BeamReference, "solver_validation": Contract, "search_sources": Query, "remember": Remember, "ask_user": Question,
    "read_source": SourceRange, "read_tool_result": ToolResultRange, "read_script": ScriptRange,
    "inspect_geometry": Selection, "list_topology": TopologyPage, "native_api": ApiQuery, "finish": Finish,
    'set_modeling_requirements': SetModelingRequirements, 'check_modeling': Contract,
    'register_code_module':RegisterCodeModule,'search_code_modules':SearchCodeModules,
    'read_code_module':ReadCodeModule,'patch_code_module':PatchCodeModule,'read_code_assembly':ReadCodeAssembly}


@lru_cache(maxsize=1)
def _schema_templates():
    tools = []
    for name, definition in TOOL_REGISTRY.items():
        model = definition.model
        schema = model.model_json_schema()
        for key in ("command_id", "idempotency_key", "expected_head"):
            schema["properties"].pop(key, None)
        if "required" in schema:
            schema["required"] = [key for key in schema["required"] if key in schema["properties"]]
        if name in ('preview_build','build_geometry'):
            schema['required'] = [key for key in schema.get('required', []) if key != 'script']
        if name == 'preview_build':
            schema['properties']['script_edits'] = {'type':'array', 'minItems':1, 'maxItems':8,
                                                     'items':ScriptEdit.model_json_schema()}
            schema['properties']['base_script_sha256'] = {'type':'string','pattern':'^[a-f0-9]{64}$',
                'description':'Required with script_edits. Use task_focus.script_revision.sha256 or read_script.script_sha256.'}
            edit_schema=AssemblyEdit.model_json_schema()
            schema.setdefault('$defs',{}).update(edit_schema.pop('$defs',{}))
            schema['properties']['assembly_edits']={'type':'array','items':edit_schema,'minItems':1,'maxItems':24}
            schema['properties']['base_assembly_artifact']={'type':'string','pattern':'^[a-f0-9]{64}$'}
        tools.append({"type": "function", "function": {"name": name, "parameters": schema,
            "description": definition.description}})
    return packed(tools)


def tool_schemas():
    # Every projection owns its nested dictionaries; phase pruning cannot mutate
    # the immutable cached definitions used by a different task or step.
    return json.loads(_schema_templates())


def prepare(task, item, turns, workspace=None):
    arguments = item["arguments"]
    if any(key in arguments for key in ("command_id", "idempotency_key", "expected_head", "revision_id", "artifact_id")):
        raise ValueError("task command identity and revision are server-owned")
    key = f"{task['id']}.e{task['epoch']}.s{task['turns']}"
    command = {"command_id": key, "idempotency_key": key, "expected_head": task["revision"]}
    tool = item["tool"]
    if tool == 'read_batch':
        return {'calls': prepare_calls(task, arguments, turns, workspace)}
    if tool in ('register_code_module','patch_code_module'):
        return TOOL_MODELS[tool](**arguments,**command).model_dump()
    if tool in ("build_geometry", "preview_build"):
        arguments = dict(arguments)
        if 'assembly_edits' in arguments:
            if workspace is None or tool!='preview_build' or arguments.get('module_assembly') or arguments.get('script'):
                raise CadScriptError('assembly_edits requires preview_build on the current module assembly')
            from .code_modules import edit_assembly
            arguments['module_assembly']=edit_assembly(workspace,task['project'],task['revision'],
                    arguments.pop('base_assembly_artifact',None),arguments.pop('assembly_edits'))
        if arguments.get('module_assembly'):
            if workspace is None:raise CadScriptError('module assembly needs the current workspace')
            from .code_modules import resolve
            current=workspace.revision(task['project'],task['revision'])['document']
            script,_=resolve(workspace,task['project'],current,arguments['module_assembly'],arguments.get('use_current',True))
            if arguments.get('script') and arguments['script']!=script:raise CadScriptError('module plans use backend-resolved code, not a separate script')
            arguments['script']=script
        if tool == 'preview_build' and 'script' not in arguments:
            if workspace is None:
                raise CadScriptError('parameter-only preview requires the current project workspace')
            geometry = workspace.revision(task['project'], task['revision'])['document'].get('geometry')
            if not geometry:
                raise CadScriptError('当前没有可重放的模型，请提供构建脚本。')
            manifest = workspace.artifacts.manifest(geometry)
            if manifest.get('replay_available') is False or 'resolved_source' not in manifest.get('provenance', {}):
                raise CadScriptError('当前模型没有完整的本机构建来源，请提供脚本，不能猜测导入模型的参数。')
            changed = arguments.get('parameters', {})
            edits = arguments.pop('script_edits', None)
            base_hash = arguments.pop('base_script_sha256', None)
            if not isinstance(changed, dict) or not changed and not edits:
                raise CadScriptError('复用脚本预览需要非空 parameters 或 script_edits。')
            if edits is not None and (not isinstance(edits, list) or not 1 <= len(edits) <= 8):
                raise CadScriptError('script_edits 必须为1到8项精确文本替换。')
            if edits and base_hash is None:
                raise CadScriptError('局部脚本修改必须提供 base_script_sha256，可从 task_focus.script_revision 或 read_script 取得。')
            if base_hash is not None and base_hash != manifest.get('files', {}).get('source.py'):
                raise CadScriptError('脚本基础版本不匹配，本轮未执行修改。请读取当前脚本版本后重新提交局部替换。')
            unknown = set(changed) - set(manifest.get('parameters', {}))
            if unknown:
                raise CadScriptError('参数名不存在：' + ', '.join(sorted(unknown)) + '；请使用 task_focus.current_parameters 中的名称。')
            if arguments.get('replay_of') not in (None, geometry) or arguments.get('use_current') is True:
                raise CadScriptError('仅改参预览重放当前模型的原始输入；请省略 use_current 和 replay_of。')
            script = workspace.artifacts.file(geometry, 'source.py').read_text(encoding='utf-8')
            for edit in edits or []:
                edit = ScriptEdit.model_validate(edit)
                count = script.count(edit.old_text)
                if count != 1:
                    raise CadScriptError(f'局部修改的 old_text 匹配{count}处，需要恰好1处；请读取目标脚本片段后重试。')
                script = script.replace(edit.old_text, edit.new_text, 1)
            arguments.update(script=script,
                             use_current=False, replay_of=geometry)
            for field in ('tolerance_mm', 'angle_deg'):
                arguments.setdefault(field, manifest.get('settings', {}).get(field, .05 if field == 'tolerance_mm' else 10))
        if tool == "build_geometry":
            previews = [turn for turn in turns if turn["epoch"] == task["epoch"] and turn["state"] == "succeeded"
                        and turn["revision"] == task["revision"] and json.loads(turn["response"])["tool"] == "preview_build"]
            if previews:
                saved = json.loads(previews[-1]["arguments"])
                if not arguments:
                    # Execute the exact validated preflight input instead of
                    # paying the model to regenerate a potentially different script.
                    arguments = {key: value for key, value in saved.items()
                                 if key not in ("command_id", "idempotency_key", "expected_head")}
                else:
                    proposed = Build(**arguments, **command).model_dump()
                    reviewed = Build.model_validate(saved).model_dump()
                    fields = ('script', 'parameters', 'tolerance_mm', 'angle_deg', 'use_current', 'replay_of','module_assembly')
                    if any(proposed[field] != reviewed[field] for field in fields):
                        raise CadScriptError('构建脚本或参数与最近预览不同。本轮未提交作业；请先对新输入调用 preview_build，再用 build_geometry({}) 执行保存的预览。')
                arguments["expected_impact_digest"] = json.loads(previews[-1]["receipt"])["digest"]
        build = Build(**arguments, **command).model_dump()
        validate_box_calls(build["script"])
        validate_boolean_reuse(build["script"])
        failed = next((turn for turn in reversed(turns) if turn['epoch'] == task['epoch'] and turn['state'] == 'failed'
                       and json.loads(turn['response'] or '{}').get('tool') == 'build_geometry'
                       and json.loads(turn.get('receipt') or '{}').get('recoverable')), None)
        if tool == 'build_geometry' and failed and failed.get('arguments'):
            previous = json.loads(failed['arguments'])
            if all(previous.get(field) == build.get(field) for field in
                   ('script', 'parameters', 'tolerance_mm', 'angle_deg', 'use_current', 'replay_of')):
                raise CadScriptError('失败脚本及构建输入没有改变，本轮未重新提交作业。请先根据 latest_failure 修正脚本，再预览和构建。')
        return build
    if tool == "configure_study":
        return ConfigureStudy(**arguments, **command).model_dump(exclude_none=True)
    if tool == "remember":
        return Remember(**arguments, **command).model_dump()
    if tool == 'set_modeling_requirements':
        return SetModelingRequirements(**arguments, **command).model_dump()
    if tool == "solve":
        return Solve(**arguments, **command).model_dump()
    if tool == "assessment":
        return Contract(**arguments).model_dump()
    model = TOOL_MODELS[tool]
    return model(**arguments).model_dump(exclude_none=True)


def _run_analysis_context(workspace, queries, task, arguments):
    project = task['project']
    from .analysis_context import analysis_context
    document = workspace.revision(project, task['revision'])['document']
    source = {}
    if task.get('source'):
        with workspace.db() as db:
            row = db.execute('SELECT payload FROM sources WHERE id=? AND project=?', (task['source'], project)).fetchone()
        source = json.loads(row[0]) if row else {}
    candidate = source.get('analysis_draft') if source.get('revision_id') == task['revision'] else None
    return analysis_context(workspace, document, task['revision'], candidate=candidate, **arguments)

def _run_beam_reference(workspace, queries, task, arguments):
    from .verification import beam_reference
    return beam_reference(arguments)

def _run_solver_validation(workspace, queries, task, arguments):
    from .verification import latest_evidence
    return latest_evidence(workspace)

def _run_preview_build(workspace, queries, task, arguments):
    project = task['project']
    return preview_build(workspace, project, arguments)

def _run_build_geometry(workspace, queries, task, arguments):
    project = task['project']
    fence = (task['id'], task['epoch'])
    if workspace.revision(project, task["revision"])["document"]["geometry"] and not arguments.get("expected_impact_digest"):
        raise ValueError("preview existing geometry changes before submitting a build")
    return workspace.enqueue(project, arguments, "cad", fence=fence)

def _run_solve(workspace, queries, task, arguments):
    project = task['project']
    fence = (task['id'], task['epoch'])
    if json.loads(task.get('config') or '{}').get('mode') == 'deepseek/1':
        evidence = assess(workspace, project, task['revision'])
        if evidence.get('evidence_job_id'):
            return analysis_receipt(workspace.job(evidence['evidence_job_id']), reused=True)
    return workspace.enqueue(project, arguments, "fea", fence=fence)

def _run_configure_study(workspace, queries, task, arguments):
    project = task['project']
    fence = (task['id'], task['epoch'])
    def configure(db):
        current = workspace._revision(db, project)
        study = configure_study(workspace, current['document'], arguments['study'])
        if packed(study) == packed(current['document'].get('study')):
            return {**current, 'unchanged': True}
        return workspace._commit(db, project, current['revision_id'], {**current['document'], 'study': study})
    return workspace.command(project, arguments, configure, fence=fence)

def _run_assessment(workspace, queries, task, arguments):
    project = task['project']
    return assess(workspace, project, task["revision"])

def _run_search_sources(workspace, queries, task, arguments):
    project = task['project']
    return {"sources": search(workspace, project, arguments["query"])}

def _run_remember(workspace, queries, task, arguments):
    project = task['project']
    fence = (task['id'], task['epoch'])
    from .engineering_memory import record
    return record(workspace, project, arguments, fence=fence, authored_by="model")

def _run_set_modeling_requirements(workspace, queries, task, arguments):
    project = task['project']
    fence = (task['id'], task['epoch'])
    from .modeling import set_requirements
    receipt = set_requirements(workspace, project, arguments, fence=fence)
    return {'revision_id': receipt['revision_id'], 'requirement_count': len(arguments['requirements']),
            'source_ids': sorted({source for item in arguments['requirements'] for source in item['source_ids']})}

def _run_check_modeling(workspace, queries, task, arguments):
    project = task['project']
    from .modeling import assess_geometry
    return assess_geometry(workspace, project, task['revision'])

def _run_read_tool_result(workspace, queries, task, arguments):
    project = task['project']
    from .storage import Missing
    from .task_memory import current_receipt
    from .engineering_memory import lineage
    with workspace.db() as db:
        turn = db.execute('SELECT t.*,a.source AS task_source FROM agent_turns t JOIN agent_tasks a ON a.id=t.task '
                          'WHERE t.id=? AND a.project=?', (arguments['turn_id'], project)).fetchone()
        if not turn or not turn['response'] or turn['state'] == 'redacted':
            raise Missing('tool result unavailable in this project')
        rows = {row['id']: json.loads(row['payload']) for row in db.execute('SELECT id,payload FROM sources WHERE project=?', (project,))}
        origin = next((key for key, value in rows.items() if value.get('task_id') == turn['task']
                       and value.get('epoch') == turn['epoch'] and value.get('origin') != 'deleted'), turn['task_source'])
        revision = workspace._revision(db, project, task['revision'])
    response = json.loads(turn['response'])
    receipt = current_receipt(rows, revision, response.get('tool'), json.loads(turn['receipt'] or '{}'))
    saved_arguments = json.loads(turn['arguments']) if turn['arguments'] else response.get('arguments', {})
    saved_arguments = {key: value for key, value in saved_arguments.items()
                       if key not in ('command_id', 'idempotency_key', 'expected_head')}
    if receipt.get('context_status') == 'source_no_longer_applicable':
        saved_arguments = {}
    text = packed({'tool': response.get('tool'), 'arguments': saved_arguments,
                   'state': turn['state'], 'receipt': receipt, 'error': turn['error']})
    source_ids = lineage(rows, [origin] + response.get('request', {}).get('source_ids', []) + receipt.get('source_ids', [])
                         + [item['source_id'] for item in receipt.get('sources', [])]
                         + ([receipt['source_id']] if receipt.get('source_id') else []))
    offset, limit = arguments['offset'], arguments['limit']
    return {'turn_id': turn['id'], 'revision_id': turn['revision'], 'epoch': turn['epoch'], 'source_ids': source_ids,
            'offset': offset, 'total_characters': len(text), 'text': text[offset:offset + limit]}

def _run_read_source(workspace, queries, task, arguments):
    project = task['project']
    from .engineering_memory import available, lineage
    from .storage import Missing
    with workspace.db() as db:
        rows = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=?", (project,))}
    source = arguments["source_id"]
    if not available(rows, source):
        raise Missing("source unavailable in this project")
    value = rows[source]
    text, offset, limit = value["text"], arguments["offset"], arguments["limit"]
    return {"source_id": source, "source_ids": lineage(rows, [source]), "origin": value.get("origin"),
        "revision_id": value.get("revision_id"), "offset": offset, "total_characters": len(text), "text": text[offset:offset + limit],
        "meaning": value.get("meaning", "source statement, not numerical evidence")}

def _run_ask_user(workspace, queries, task, arguments):
    return arguments

def _run_finish(workspace, queries, task, arguments):
    from .modeling import completion
    arguments = Finish.model_validate(arguments).model_dump()
    result = completion(workspace, task, arguments)
    return {**arguments, 'completion': result, 'source_ids': result['source_ids'],
            "origin": "model_or_user_summary_not_numerical_evidence"}

def _run_native_api(workspace, queries, task, arguments):
    return queries.native_api(arguments)

def _run_list_topology(workspace, queries, task, arguments):
    geometry = _geometry(workspace, task)
    manifest = workspace.artifacts.manifest(geometry)
    entries = []
    for body in manifest["bodies"]:
        for kind, items in (("body", [body]), ("face", body["faces"]), ("edge", body.get("edges", []))):
            for item in items:
                if arguments["query"].lower() in (item["id"] + " " + kind + " " + body["name"]).lower():
                    entries.append({"id": item["id"], "kind": kind, "body_name": body["name"],
                        **{key: item[key] for key in ("bbox_mm", "area_mm2", "length_mm", "volume_mm3") if key in item}})
    return {"artifact_id": geometry, "revision_id": task["revision"], "entries": entries[arguments["offset"]:arguments["offset"] + arguments["limit"]],
            "total_matches": len(entries), "offset": arguments["offset"]}

def _run_read_script(workspace, queries, task, arguments):
    geometry = _geometry(workspace, task)
    script = workspace.artifacts.file(geometry, "source.py").read_text(encoding="utf-8")
    offset, limit = arguments["offset"], arguments["limit"]
    return {"artifact_id": geometry, 'script_sha256':workspace.artifacts.manifest(geometry)['files']['source.py'],
            "offset": offset, "total_characters": len(script), "text": script[offset:offset + limit]}

def _run_register_code_module(workspace, queries, task, arguments):
    from . import code_modules
    return code_modules.register(workspace, task['project'], arguments, (task['id'], task['epoch']))

def _run_search_code_modules(workspace, queries, task, arguments):
    from . import code_modules
    return code_modules.search(workspace, task['project'], arguments)

def _run_read_code_module(workspace, queries, task, arguments):
    from . import code_modules
    return code_modules.read(workspace, task['project'], arguments)

def _run_patch_code_module(workspace, queries, task, arguments):
    from . import code_modules
    return code_modules.patch_module(workspace, task['project'], arguments, (task['id'], task['epoch']))

def _run_read_code_assembly(workspace, queries, task, arguments):
    from . import code_modules
    return code_modules.read_assembly(workspace, task['project'], arguments)


def _geometry(workspace, task):
    geometry = workspace.revision(task['project'], task['revision'])['document']['geometry']
    if not geometry:
        raise ValueError('当前版本还没有几何模型，无法读取拓扑、测量或建模脚本；请先成功构建几何。查询 CAD 接口文档可使用 native_api。')
    return geometry


def _run_inspect_geometry(workspace, queries, task, arguments):
    geometry = _geometry(workspace, task)
    request = InspectGeometry(**arguments, revision_id=task['revision'], artifact_id=geometry)
    result = queries.inspect(task['project'], {**request.model_dump(exclude_none=True), 'metrics_only': True})
    result.pop('visual')
    return result


@dataclass(frozen=True)
class ToolDefinition:
    model: type
    description: str
    handler: Callable
    read_only: bool
    resource: str
    phases: tuple


_DESCRIPTIONS = {'read_batch': 'Read 1–4 independent bounded sources, scripts, tool receipts or topology pages in one call. Each child uses its named tool schema and must already be available. No writes, nested batches or guessed dependencies. Text limit <=2000, topology limit <=8; larger results fail explicitly. Receipts keep ordered child identities and expand through read_tool_result.', "native_api": "Read installed CAD signatures. Batch up to 4 lookups with queries=[{query:'create_cylinder'},{query:'linear_sweep'}] in ONE call. Space or | separated keywords match alternatives. Functions and exact names rank first. Reuse cad_api_reference from context; do not query known signatures again. suggest_query is not a parameter.",
                'register_code_module':'Register immutable Python for one reusable local-coordinate Brep in result. Declare parameter types/units/bounds, source IDs and optional requirement bindings. Syntax checked, not geometry verified. Code is stored outside dialogue. Modules receive u, parameters, params and declared dependency parts as copies.',
                'search_code_modules':'Find project-scoped compatible module interfaces by tags, parameter names and text; semantic=true enables optional local reranking. Returns exact version references, no source code.',
                'read_code_module':'Read a bounded source range of one exact module version. Do not reconstruct modules from historical prose.',
                'patch_code_module':'Create a new immutable version from exact unique text replacements at code_revision; preserve the module contract and link new source IDs.',
                'read_code_assembly':'Read a bounded slice or one component of the current exact assembly plan, including parameter and placement bindings. No Python code is replayed.',
                "list_topology": "List current artifact's body/face/edge IDs, bounding boxes and geometric metrics; paginated. Use before querying unknown topology IDs.",
                "inspect_geometry": "Measure explicit IDs from list_topology, or resolve a known point; this does not list or discover all topology.",
                "analysis_context": "Read the current static-analysis scope, exact face IDs/bounds/areas, saved study, conflicts, supported physics and missing physical inputs. Call before planning a static study. Optional body_ids selects planning scope without saving it; paginate faces with offset/limit. No solver or model is run.",
                "configure_study": "Configure material, fixed supports and total-force loads. face=x-min/x-max/y-min/y-max/z-min/z-max selects bounding faces; precise regions are optional.",
                "preview_build": "Preview edits to existing geometry. Prefer parameters={existing_name:value}, or script_edits=[{old_text:'exact unique snippet',new_text:'replacement'}] with base_script_sha256 for local code changes; omit script/use_current/replay_of. Reuses saved code and original inputs; never guesses a replacement target. Read a bounded range if needed. Full script only for a full redesign. After preview call build_geometry({}).",
                "assessment": "Read deterministic engineering evidence; missing evidence is unknown.",
                "beam_reference": "Independent rectangular axial-bar or Euler-Bernoulli cantilever calculation. Explicit mm/N/MPa/kg inputs required; not a CAD-part simulation or certification.",
                "solver_validation": "Read latest completed benchmark for the current solver implementation. Does not run a benchmark or certify the current part. Missing report means unknown.",
                "remember": "Save a concise requirement, decision or open question grounded in source_ids from context. Use supersedes to explicitly replace old memory. Summaries are not solver evidence; never invent sources.",
                "read_source": "Expand a retrieved source or historical tool receipt in bounded chunks. Verify its revision before using it as evidence.",
                "read_tool_result": "Expand a saved tool instruction, receipt or failure by turn_id in bounded chunks. Latest observations provide this reference. Check revision and state before using it.",
                "ask_user": "Pause for required missing information; never invent loads, material or constraints.",
                'set_modeling_requirements': 'Register the complete current modeling requirements grounded in source_ids before a build. Preserve unchanged prior requirements. Numeric min/max bounds use actual global bbox dimensions in mm, volume in mm3, or body counts. Record unsupported shape/assembly features as metric=manual; never omit them or invent numerical targets.',
                'check_modeling': 'Check the current artifact against registered modeling requirements. Manual features remain unknown. This does not verify unregistered features, overall shape, or structural safety.',
                "finish": "End the reply. outcome=answer for discussion; built for constructed geometry without full checks, partial for incomplete geometry, verified only when all registered checks pass. Include remaining limitations in summary. Backend validates against current geometry; it is not engineering certification."}

_MODELING_ONLY = frozenset(('native_api', 'read_script', 'preview_build', 'build_geometry',
    'set_modeling_requirements', 'check_modeling', 'register_code_module', 'search_code_modules',
    'read_code_module', 'patch_code_module', 'read_code_assembly'))
_EXCLUSIVE = frozenset(('preview_build', 'build_geometry', 'configure_study', 'solve', 'remember',
    'set_modeling_requirements', 'register_code_module', 'patch_code_module', 'ask_user', 'finish'))
_RESOURCES = {'native_api': 'query', 'inspect_geometry': 'query', 'build_geometry': 'native-job',
              'solve': 'native-job', 'search_sources': 'retrieval', 'search_code_modules': 'retrieval'}
_HANDLERS = {
    'read_batch': execute_batch,
    'preview_build': _run_preview_build,
    'build_geometry': _run_build_geometry,
    'configure_study': _run_configure_study,
    'solve': _run_solve,
    'assessment': _run_assessment,
    'analysis_context': _run_analysis_context,
    'beam_reference': _run_beam_reference,
    'solver_validation': _run_solver_validation,
    'search_sources': _run_search_sources,
    'remember': _run_remember,
    'ask_user': _run_ask_user,
    'read_source': _run_read_source,
    'read_tool_result': _run_read_tool_result,
    'read_script': _run_read_script,
    'inspect_geometry': _run_inspect_geometry,
    'list_topology': _run_list_topology,
    'native_api': _run_native_api,
    'finish': _run_finish,
    'set_modeling_requirements': _run_set_modeling_requirements,
    'check_modeling': _run_check_modeling,
    'register_code_module': _run_register_code_module,
    'search_code_modules': _run_search_code_modules,
    'read_code_module': _run_read_code_module,
    'patch_code_module': _run_patch_code_module,
    'read_code_assembly': _run_read_code_assembly,
}
if _HANDLERS.keys() != _PARAMETER_MODELS.keys():
    raise ValueError('tool models and handlers must declare the same capabilities')
TOOL_REGISTRY = MappingProxyType({name: ToolDefinition(model, _DESCRIPTIONS.get(name, name), _HANDLERS[name],
    name not in _EXCLUSIVE, _RESOURCES.get(name, 'workspace'),
    ('modeling',) if name in _MODELING_ONLY else ('modeling', 'analysis'))
    for name, model in _PARAMETER_MODELS.items()})
# Compatibility for existing typed callers; definitions above own the selection.
TOOL_MODELS = MappingProxyType({name: definition.model for name, definition in TOOL_REGISTRY.items()})


def execute(workspace, queries, task, tool, arguments):
    definition = TOOL_REGISTRY.get(tool)
    if definition is None:
        raise ValueError('unknown task tool')
    return definition.handler(workspace, queries, task, arguments)
