"""One durable model request checkpoint, then one existing fenced tool step."""
import hashlib
import json
import ast
import time
import zlib
from pydantic import ValidationError

from . import provider
from .storage import Conflict, identity, packed
from .task_memory import context
from .task_tools import prepare, CadScriptError
from .modeling import CompletionError
from .tool_admission import ToolAdmission

MODE = "deepseek/1"


def rejection_kind(turn):
    response = json.loads(turn.get('response') or '{}')
    receipt = response.get('provider', {})
    return response.get('rejection_kind') or receipt.get('rejection_kind') or (
        'truncated_output' if receipt.get('finish_reason') == 'length' else
        'missing_tool_call' if receipt.get('finish_reason') == 'stop' else
        'multiple_calls' if response.get('tool') == 'model_protocol_rejected' else 'arguments')


def repair_exhausted(task, turns, kind):
    consecutive = []
    for turn in reversed(turns):
        if turn['epoch'] != task['epoch'] or turn['state'] != 'rejected':
            break
        consecutive.append(turn)
    return len(consecutive) >= 2 or bool(consecutive and rejection_kind(consecutive[0]) == kind)


def planning_progress(task, turns, runtime_id=None):
    """Detect stalled preparation, independent of cumulative request/job budgets."""
    lookups, stale, rejected, seen = 0, 0, 0, set()
    repeated, blocked = {}, set()
    preparation_steps, previews = 0, 0
    post_build, post_build_reads = False, 0
    if runtime_id is None:
        runtime_id = next((json.loads(turn.get('receipt') or '{}').get('runtime_id') for turn in reversed(turns)
                           if json.loads(turn.get('receipt') or '{}').get('runtime_id')), None)
    def known_symbols(turn):
        receipt = json.loads(turn.get('receipt') or '{}')
        if receipt.get('runtime_id') != runtime_id:
            return set()
        groups = receipt.get('lookups', [receipt])
        entries = [entry for group in groups for entry in group.get('entries', [])]
        entries += receipt.get('capability_index', {}).get('core_signatures', [])
        return {entry['symbol'] for entry in entries if entry.get('symbol') and (entry.get('documentation') or entry.get('signature'))}
    for turn in turns:
        if turn['epoch'] < task['epoch'] and turn['state'] == 'succeeded' and json.loads(turn['response'] or '{}').get('tool') == 'native_api':
            seen.update(known_symbols(turn))
    for turn in turns:
        if turn["epoch"] != task["epoch"]:
            continue
        value = json.loads(turn["response"] or "{}")
        if turn["state"] == "rejected":
            rejected += 1
            continue
        if turn["state"] != "succeeded":
            continue
        tool = value.get("tool")
        if tool == 'build_geometry':
            post_build, post_build_reads = True, 0
        elif tool in ('configure_study', 'solve'):
            post_build = False
        elif post_build and tool in ('list_topology', 'inspect_geometry', 'check_modeling', 'read_batch'):
            post_build_reads += 1
        if tool in ('native_api', 'preview_build', 'list_topology', 'inspect_geometry', 'analysis_context', 'read_batch'):
            preparation_steps += 1
        if tool == 'preview_build':
            previews += 1
        if tool in ("build_geometry", "configure_study", "solve"):
            lookups, stale, rejected = 0, 0, 0
            repeated, blocked = {}, set()
            preparation_steps, previews = 0, 0
        elif tool == "native_api":
            lookups += 1
            receipt_runtime = json.loads(turn.get('receipt') or '{}').get('runtime_id')
            if receipt_runtime and receipt_runtime != runtime_id:
                continue
            symbols = known_symbols(turn)
            stale = 0 if symbols - seen else stale + 1
            seen.update(symbols)
        elif tool in ('preview_build', 'read_script', 'read_source', 'read_tool_result', 'list_topology', 'inspect_geometry', 'analysis_context', 'search_sources', 'set_modeling_requirements', 'check_modeling', 'read_batch'):
            arguments = {key: value for key, value in value.get('arguments', {}).items()
                         if key not in ('command_id', 'idempotency_key', 'expected_head')}
            if tool == 'analysis_context':
                arguments.pop('limit', None)  # Different limits yielding the same page are not new information.
            if tool == 'preview_build':
                arguments.pop('expected_impact_digest', None)
                try:
                    arguments['script'] = ast.dump(ast.parse(arguments.get('script', '')), include_attributes=False)
                except SyntaxError:
                    pass
            receipt = {} if tool == 'preview_build' else json.loads(turn.get('receipt') or '{}')
            if tool == 'read_batch':
                receipt = {'calls': [{key: call.get(key) for key in ('tool', 'state', 'receipt', 'error')}
                                     for call in receipt.get('calls', [])]}
            signature = packed({'tool': tool, 'arguments': arguments,
                                'revision': turn.get('revision'),
                                'receipt': receipt})
            repeated[signature] = repeated.get(signature, 0) + 1
            if repeated[signature] >= (2 if tool == 'analysis_context' else 3):
                blocked.add(tool)
    if stale >= 3:
        blocked.add('native_api')
    if preparation_steps >= 8:
        blocked.update(('native_api', 'list_topology', 'inspect_geometry', 'read_batch'))
    if previews >= 3:
        blocked.add('preview_build')
    return {"api_lookups_since_progress": lookups, "consecutive_uninformative_lookups": stale,
            "protocol_rejections_since_progress": rejected,
            'preparation_steps_since_execution': preparation_steps,
            'previews_since_execution': previews,
            'post_build_inspections':post_build_reads,
            "ready_to_build": lookups >= 6,
            "recovery_required": bool(blocked) or rejected >= 3, 'blocked_tools': sorted(blocked),
            "meaning": "Preparation watchdog, not a cumulative request budget. Reuse known signatures and build, or explain the concrete missing capability."}


def configuration(request, root=None):
    if not provider.status(root)["configured"]:
        raise ValueError("Configure backend DEEPSEEK_API_KEY or root .env before starting a DeepSeek task")
    return {"mode": MODE, "model": provider.settings(root), "plan": [], "max_jobs": request["max_jobs"], "unlimited": request.get("unlimited", False),
        "max_requests": request["max_requests"], "max_total_tokens": 250000, "used_tokens": 0,
        "started_at": time.time(), "max_seconds": 600, "data_scope": "deepseek-project-context/1"}


def prepare_request(runner, task, turns, config):
    prepared_at = time.monotonic()
    if not config.get("unlimited") and (task["turns"] >= config["max_requests"] or time.time() - config["started_at"] > config["max_seconds"]):
        raise ValueError("model request/time budget reached; submit an explicit correction to continue")
    repairing = bool(turns and turns[-1]["epoch"] == task["epoch"] and turns[-1]["state"] == "rejected")
    from .queries import api_identity
    extra = {'planning_progress': planning_progress(task, turns, api_identity())}
    if repairing:
        extra["last_tool_rejection"] = {"reason": turns[-1]["error"], "kind":rejection_kind(turns[-1]), "tools_executed": False}
    compiled, metadata = context(runner.workspace, task, turns, budget=24000 - len(packed(extra)))
    compiled.update(extra)
    metadata['budget_characters'] = 24000
    compiled_text = packed(compiled)
    metadata.update(characters=len(compiled_text), sha256=hashlib.sha256(compiled_text.encode()).hexdigest(),
                    estimated_text_tokens_upper_bound=len(compiled_text.encode("utf-8")))
    context_ms = round((time.monotonic() - prepared_at) * 1000, 3)
    schema_at = time.monotonic()
    request = provider.payload(compiled, config["model"])
    admission = ToolAdmission.capture(request['tools'])
    schema_ms = round((time.monotonic() - schema_at) * 1000, 3)
    if repairing:
        request['messages'][0]['content'] += '\n' + (
            "Your previous tool response was rejected and NONE were executed. Read last_tool_rejection in the project data. "
            "Return exactly ONE function call using only fields and types in its offered schema. "
            "Choose only the next necessary step, then wait for its receipt. Do not batch calls, even read-only queries.")
        if extra['last_tool_rejection']['kind'] == 'truncated_output':
            request['reasoning_effort'] = 'low'
            request['messages'][0]['content'] += (
                '\nOutput was truncated. Do not resend a whole assembly program or a long explanation. '
                'For existing geometry use preview_build with exact script_edits or parameters. '
                'If a full redesign is necessary, build only one coherent component and preserve unchanged parts. '
                'Read a small script range first if the replacement target is unknown. No truncated arguments were executed.')
        if len(packed(request)) > 100000:
            raise ValueError("model request exceeds 100000-character budget")
    # UTF-8 bytes are a conservative text-token reservation, including schemas.
    reservation = len(packed(request).encode()) + request["max_tokens"]
    if not config.get("unlimited") and config["used_tokens"] + reservation > config["max_total_tokens"]:
        raise ValueError("model token budget cannot cover another bounded request")
    metadata.update(payload_sha256=hashlib.sha256(packed(request).encode()).hexdigest(), reserved_tokens=reservation,
                    timings_ms={"context": context_ms, "payload": schema_ms},
                    payload_bytes=len(packed(request).encode()), offered_tools=len(request["tools"]),
                    execution_policy="bounded-model-io/1", tool_admission_sha256=admission.sha256,
                    prompt_policy=provider.PROMPT_POLICY, prompt_characters=len(request['messages'][0]['content']),
                    schema_characters=len(packed(request['tools'])),
                    context_sections={key: len(packed(value)) for key, value in compiled.items()})
    pending = {"id": identity(), "state": "requesting_model", "arguments": None,
               "response": packed({"tool": "model_request", "request": metadata})}
    with runner.workspace.db() as db:
        current = runner.row(db, task["id"])
        if current["epoch"] != task["epoch"] or current["state"] != "executing":
            raise Conflict("task corrected before model request")
        if runner.workspace._revision(db, task["project"])["revision_id"] != task["revision"]:
            raise Conflict("project changed before model request")
        from .engineering_memory import available
        sources = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=?", (task["project"],))}
        availability = {}
        if any(not available(sources, source, availability) for source in metadata["source_ids"]):
            raise Conflict("context source was forgotten before model request")
        config["context"] = metadata
        db.execute("INSERT INTO agent_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (pending["id"], task["id"], task["epoch"], task["turns"],
            task["revision"], pending["state"], pending["response"], None, None, None, None, time.time()))
        encoded_request = packed(request).encode("utf-8")
        db.execute("INSERT INTO context_snapshots VALUES(?,?,?,?)", (pending["id"], task["project"], hashlib.sha256(encoded_request).hexdigest(), zlib.compress(encoded_request)))
        db.execute("UPDATE agent_tasks SET turns=turns+1,config=?,updated=? WHERE id=?", (packed(config), time.time(), task["id"]))
    # No transaction spans the network request. A crash here is ambiguous and is
    # paused on restart, never silently retried. The request id/digest survives.
    current, _ = runner.snapshot(task["id"])
    if current["epoch"] != task["epoch"] or current["state"] != "executing" or runner.stop.is_set():
        raise Conflict("task stopped before model transmission")
    return {"task": task, "turns": turns, "config": config, "compiled": compiled,
            "metadata": metadata, "request": request, "reservation": reservation, "pending": pending,
            "admission": admission}


def next_step(runner, task, turns, config):
    io = getattr(runner, 'model_io', None)
    if io is not None and not io.available():
        if io.closing or io.failure:
            raise ValueError('model I/O unavailable; no automatic retry, submit a correction after recovery')
        return None
    prepared = prepare_request(runner, task, turns, config)
    if io is not None:
        key = prepared['pending']['id']
        runner.model_requests[key] = prepared
        try:
            io.submit(key, (task['id'], task['epoch']), prepared['request'])
        except Exception:
            del runner.model_requests[key]
            raise
        return None
    started = time.monotonic()
    response = provider.complete(prepared['request'])
    return settle_request(runner, prepared, response, round((time.monotonic() - started) * 1000, 3))


def settle_request(runner, prepared, response, duration_ms):
    task, turns, config = (prepared[key] for key in ('task', 'turns', 'config'))
    compiled, metadata, request, reservation, pending = (prepared[key] for key in
        ('compiled', 'metadata', 'request', 'reservation', 'pending'))
    try:
        item, receipt = provider.parse(response, config["model"])
    except provider.MultipleToolCalls as error:
        receipt = error.receipt
        receipt['duration_ms'] = duration_ms
        if receipt["usage"]["total_tokens"] > reservation:
            raise ValueError("provider token usage exceeds request reservation")
        config["used_tokens"] += receipt["usage"]["total_tokens"]
        with runner.workspace.db() as db:
            current = runner.row(db, task["id"])
            if current["epoch"] != task["epoch"] or current["state"] != "executing":
                raise Conflict("late model response discarded after task correction/stop")
            db.execute("UPDATE agent_turns SET state='rejected',response=?,error=? WHERE id=?",
                (packed({"tool": "model_protocol_rejected", "provider": receipt, "request": metadata}), str(error), pending["id"]))
            db.execute("UPDATE agent_tasks SET config=?,updated=? WHERE id=?", (packed(config), time.time(), task["id"]))
        if repair_exhausted(task, turns, receipt.get('rejection_kind', 'multiple_calls')):
            raise ValueError(str(error) + " 自动纠正仍未满足协议，任务已暂停，请提交纠正。")
        return None
    receipt["duration_ms"] = duration_ms
    if receipt["usage"]["total_tokens"] > reservation:
        raise ValueError("provider token usage exceeds request reservation")
    config["used_tokens"] += receipt["usage"]["total_tokens"]
    item.update(provider=receipt, request=metadata)
    with runner.workspace.db() as db:
        current = runner.row(db, task["id"])
        if current["epoch"] != task["epoch"] or current["state"] != "executing":
            raise Conflict("late model response discarded after task correction/stop")
        # Retain provider identity/usage even when argument validation below fails.
        db.execute("UPDATE agent_turns SET response=? WHERE id=?", (packed(item), pending["id"]))
        db.execute("UPDATE agent_tasks SET config=?,updated=? WHERE id=?", (packed(config), time.time(), task["id"]))
    previous_ids = set()
    for turn in turns:
        if turn["epoch"] == task["epoch"] and turn["response"]:
            prior = json.loads(turn["response"]).get("provider", {})
            previous_ids.update(prior.get("call_ids", [prior.get("call_id")]))
    if previous_ids.intersection(receipt.get("call_ids", [receipt["call_id"]])):
        raise ValueError("duplicate model tool call id; no tool executed")
    try:
        if (compiled.get('task_focus') or {}).get('module_assembly_reference') and item['tool'] in ('preview_build','build_geometry'):
            proposed=item['arguments']
            if proposed.get('script') or proposed.get('script_edits'):
                raise CadScriptError('当前模型由代码模块组成；请 patch_code_module 更新模块版本，或用 assembly_edits 修改实例参数，再预检构建。')
        if not prepared['admission'].contains(item['tool']):
            if item['tool'] == 'build_geometry' and compiled['project'].get('geometry') and not compiled.get('latest_build_preview'):
                raise CadScriptError('现有模型尚无当前版本、当前轮次的有效预检。本轮未提交作业。请先 preview_build，再 build_geometry({})。')
            if compiled['planning_progress']['recovery_required']:
                if compiled.get('workflow_phase') == 'analysis' or compiled.get('analysis_candidate'):
                    raise CadScriptError('检测到工况信息重复读取，本轮未执行工具。请复用 analysis_setup 配置工况，或一次询问缺少的物理条件。')
                raise CadScriptError('检测到接口查询或协议纠正持续空转，本轮未执行工具。请使用已知能力完成下一步预检/构建，或如实说明具体阻碍。')
            raise CadScriptError('tool was not offered for this request; use only the offered tools and current workflow stage')
        try:
            prepared['admission'].validate_surface(item)
        except ValueError as error:
            raise CadScriptError(str(error)) from None
        arguments = prepare(task, item, turns, runner.workspace)
        if item['tool'] == 'finish':
            from .modeling import completion
            completion(runner.workspace, task, arguments)
    except (ValidationError, CadScriptError, CompletionError) as error:
        # Schema errors are feedback to the planner, never permission to strip
        # unknown fields or execute a partially validated command.
        if isinstance(error, ValidationError):
            issues = [{"field": list(issue["loc"]), "type": issue["type"], "message": issue["msg"]}
                      for issue in error.errors(include_input=False, include_url=False)[:8]]
        elif isinstance(error, CompletionError):
            issues = [{'field':['outcome'], 'type':'completion_evidence', 'message':str(error)}]
        else:
            issues = [{"field": ["script"], "type": "cad_signature", "message": str(error)}]
        message = "工具参数未通过校验，本轮未执行工具：" + packed(issues)[:1600]
        kind = 'completion_evidence' if isinstance(error, CompletionError) else 'arguments'
        item['rejection_kind'] = kind
        with runner.workspace.db() as db:
            current = runner.row(db, task["id"])
            if current["epoch"] != task["epoch"] or current["state"] != "executing":
                raise Conflict("late invalid arguments discarded after task correction/stop")
            db.execute("UPDATE agent_turns SET state='rejected',response=?,error=? WHERE id=?", (packed(item), message, pending["id"]))
        if repair_exhausted(task, turns, kind):
            raise ValueError(message + "；自动纠正仍未通过，任务已暂停。") from None
        return None
    is_job = item["tool"] in ("build_geometry", "solve")
    if is_job and not config.get("unlimited") and task["jobs"] >= config["max_jobs"]:
        raise ValueError("task job budget reached")
    if item["tool"] == "build_geometry" and not provider.has_cad_reference(compiled) and not arguments.get('module_assembly'):
        raise ValueError("当前运行版本的 CAD 接口文档尚未查询或已失效，需要先重新查询接口签名，再继续建模。")
    with runner.workspace.db() as db:
        current = runner.row(db, task["id"])
        if current["epoch"] != task["epoch"] or current["state"] != "executing":
            raise Conflict("late model response discarded after task correction/stop")
        if runner.workspace._revision(db, task["project"])["revision_id"] != task["revision"]:
            raise Conflict("project changed while waiting for model response")
        pending.update(state="executing", response=packed(item), arguments=packed(arguments))
        db.execute("UPDATE agent_turns SET state='executing',response=?,arguments=? WHERE id=?", (pending["response"], pending["arguments"], pending["id"]))
        db.execute("UPDATE agent_tasks SET config=?,updated=? WHERE id=?", (packed(config), time.time(), task["id"]))
    return pending
