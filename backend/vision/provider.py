"""Bounded DeepSeek-only transport; no project files or credentials in payloads."""
import asyncio
import json
import os
from pathlib import Path
import re

import httpx

from .contracts import TaskStep
from .storage import packed
from .task_tools import tool_schemas, TOOL_REGISTRY
from .read_batch import READ_TOOLS
from .prompts import SYSTEM, PROMPT_POLICY, system_prompt, iteration_prompt

URL = "https://api.deepseek.com/chat/completions"
MODELS = ("deepseek-flash", "deepseek-v4-pro")


class MultipleToolCalls(ValueError):
    """A complete, metered response that must execute no tools."""
    def __init__(self, receipt):
        self.receipt = receipt
        super().__init__(receipt.get("reason") or f"DeepSeek 一次返回了 {receipt['call_count']} 个工具调用，本轮均未执行；需要每次只返回一个调用。")


class IncompleteToolResponse(MultipleToolCalls):
    """A metered, completed request with no executable tool response."""




def settings(root=None):
    model = os.environ.get("VISION_DEEPSEEK_MODEL", "deepseek-flash")
    path = Path(root) / "model-settings.json" if root else None
    if path and path.is_file():
        model = json.loads(path.read_text(encoding="utf-8"))["model"]
    if model not in MODELS:
        raise ValueError("VISION_DEEPSEEK_MODEL must be deepseek-flash or deepseek-v4-pro")
    return model


def status(root=None):
    return {"provider": "deepseek", "endpoint": URL, "model": settings(root),
            "configured": bool(api_key()),
            "timeout_seconds": 180, "max_output_tokens": 16384, 'thinking_policy':'fast-low-complex-plan-high'}


def api_key():
    if "DEEPSEEK_API_KEY" in os.environ:
        return os.environ["DEEPSEEK_API_KEY"].strip()
    path = Path(__file__).resolve().parents[2] / ".env"
    if path.is_file():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if line.strip().startswith("DEEPSEEK_API_KEY="):
                value = line.strip().split("=", 1)[1].strip()
                return value[1:-1] if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'" else value
    return ""


def has_cad_reference(compiled):
    return bool(compiled.get('cad_api_reference') or compiled.get('cad_api_signatures')
                or (compiled.get('cad_capability_index') or {}).get('core_signatures'))


def payload(compiled, model):
    tools = tool_schemas()
    setup = compiled.get('analysis_setup') or {}
    analyzing = compiled.get('workflow_phase') == 'analysis' or bool(compiled.get('analysis_candidate')) or bool(setup)
    if analyzing:
        tools = [tool for tool in tools if 'analysis' in TOOL_REGISTRY[tool['function']['name']].phases]
    module_mode=bool((compiled.get('task_focus') or {}).get('module_catalog') or (compiled.get('task_focus') or {}).get('module_assembly_reference')
                     or (compiled.get('task_focus') or {}).get('failed_modules')) or len(compiled.get('project',{}).get('modeling_plan',[]))>=2
    module_tools={'register_code_module','search_code_modules','read_code_module','patch_code_module','read_code_assembly'}
    if (compiled.get('task_focus') or {}).get('module_assembly_reference'):
        tools=[tool for tool in tools if tool['function']['name']!='read_script']
    if not module_mode:
        tools=[tool for tool in tools if tool['function']['name'] not in module_tools]
        for tool in tools:
            if tool['function']['name'] in ('build_geometry','preview_build'):
                schema=tool['function']['parameters']
                for key in ('module_assembly','assembly_edits','base_assembly_artifact'):schema['properties'].pop(key,None)
                for key in ('CodeInstance','CodeParameterRef'):schema.get('$defs',{}).pop(key,None)
                if tool['function']['name']=='build_geometry':schema['required']=['script']
    has_api_evidence = has_cad_reference(compiled)
    module_evidence=bool((compiled.get('task_focus') or {}).get('module_catalog'))
    construction_evidence=has_api_evidence or module_evidence
    if not has_api_evidence and not module_evidence:
        tools = [tool for tool in tools if tool["function"]["name"] not in ("build_geometry", "preview_build")]
    elif not has_api_evidence or (compiled.get('task_focus') or {}).get('module_assembly_reference'):
        for tool in tools:
            if tool['function']['name'] in ('build_geometry','preview_build'):
                parameters=tool['function']['parameters']
                parameters['properties']={key:value for key,value in parameters['properties'].items() if key in ('module_assembly','tolerance_mm','angle_deg','use_current','assembly_edits','base_assembly_artifact')}
                parameters['required']=[] if tool['function']['name']=='preview_build' else ['module_assembly']
    has_modeling_goals = bool(compiled.get('project', {}).get('modeling_requirements')) and compiled.get('model_completion_state', {}).get('requirement_sources_current', True)
    if not has_modeling_goals:
        tools = [tool for tool in tools if tool['function']['name'] not in ('build_geometry', 'preview_build')]
    if not compiled.get("project", {}).get("geometry"):
        unavailable = {"list_topology", "inspect_geometry", "read_script", "solve", "configure_study", "analysis_context", "preview_build"}
        tools = [tool for tool in tools if tool["function"]["name"] not in unavailable]
    analysis = compiled.get('latest_analysis') or {}
    if analysis.get('current_revision') and analysis.get('epoch') == compiled.get('epoch') and analysis.get('job', {}).get('state') == 'succeeded':
        tools = [tool for tool in tools if tool['function']['name'] != 'solve']
    if setup.get('revision_id') == compiled['revision_id'] and setup.get('epoch') == compiled.get('epoch') and 'next_face_offset' in setup and setup['next_face_offset'] is None:
        tools = [tool for tool in tools if tool['function']['name'] != 'analysis_context']
    groups = compiled.get("recent_tool_groups", [])
    preview = compiled.get('latest_build_preview') or {}
    has_preview = (preview.get('revision_id') == compiled['revision_id'] and preview.get('epoch') == compiled.get('epoch'))
    if has_preview or any(group.get("revision_id") == compiled["revision_id"] and group.get("epoch") == compiled.get("epoch") and group["instruction"]["tool"] == "preview_build" for group in groups):
        has_preview = True
        for tool in tools:
            if tool["function"]["name"] == "build_geometry":
                tool["function"]["parameters"] = {"type":"object", "properties":{}, "additionalProperties":False}
                tool["function"]["description"] = "Execute exactly the latest successful preview_build saved at this revision. Send {}. To modify inputs, run preview_build again first."
    elif compiled.get('project', {}).get('geometry'):
        tools = [tool for tool in tools if tool['function']['name'] != 'build_geometry']
    last_change = max((index for index, group in enumerate(groups) if group["instruction"]["tool"] in ("build_geometry", "configure_study", "solve")), default=-1)
    if any(index > last_change and group.get("revision_id") == compiled["revision_id"] and group["instruction"]["tool"] == "assessment"
           for index, group in enumerate(groups)):
        tools = [tool for tool in tools if tool["function"]["name"] != "assessment"]
    recovering = compiled.get("planning_progress", {}).get("recovery_required")
    if recovering:
        recovery_tools = {'configure_study', 'solve', 'assessment', 'ask_user', 'finish', 'read_tool_result', 'analysis_context'} if analyzing else {"preview_build", "build_geometry", "ask_user", "finish"} if construction_evidence else {"ask_user", "finish"}
        if construction_evidence and not has_modeling_goals:
            recovery_tools.add('set_modeling_requirements')
        if compiled.get('latest_failure'):
            recovery_tools.add('read_tool_result')
            if module_mode:
                recovery_tools.update(module_tools)
        tools = [tool for tool in tools if tool["function"]["name"] in recovery_tools]
        blocked = set(compiled.get('planning_progress', {}).get('blocked_tools', []))
        tools = [tool for tool in tools if tool['function']['name'] not in blocked]
    next_action = ('native_api' if not construction_evidence else 'set_modeling_requirements' if not has_modeling_goals else
                   'preview_build' if compiled.get('project', {}).get('geometry') and not has_preview else 'build_geometry')
    focus = compiled.get('task_focus')
    last_build_state = (focus or {}).get('last_build_state')
    complex_plan = len(compiled.get('project', {}).get('modeling_plan', [])) >= 4
    latest_tool = (compiled.get('latest_observation') or {}).get('tool')
    checked_build = (last_build_state == 'succeeded' and compiled.get('model_completion_state', {}).get('status') in ('checks_passed', 'needs_review'))
    if not analyzing and checked_build:
        next_action = 'finish'
        if compiled.get('planning_progress', {}).get('post_build_inspections', 0) >= 2:
            tools = [tool for tool in tools if tool['function']['name'] not in ('list_topology', 'inspect_geometry', 'check_modeling', 'native_api', 'read_batch')]
    planning = complex_plan and last_build_state is None and latest_tool == 'set_modeling_requirements'
    repairing_build = last_build_state == 'failed' and latest_tool == 'build_geometry'
    reasoning_effort = 'high' if has_api_evidence and has_modeling_goals and not has_preview and (planning or repairing_build) else 'low'
    if not analyzing and focus is not None and has_preview:
        # A preview already contains exact build inputs. Further topology or
        # source queries inspect the old geometry, not that unexecuted script.
        after_preview = {'build_geometry', 'preview_build', 'ask_user', 'finish', 'read_tool_result'}
        tools = [tool for tool in tools if tool['function']['name'] in after_preview]
    names = {tool['function']['name'] for tool in tools}
    batch = next((tool for tool in tools if tool['function']['name'] == 'read_batch'), None)
    if batch:
        allowed_reads = [name for name in READ_TOOLS if name in names]
        if allowed_reads:
            batch['function']['parameters']['$defs']['ReadCall']['properties']['tool']['enum'] = allowed_reads
        else:
            tools.remove(batch)
    # Each call starts a fresh, fully checkpointed request. No assistant/tool
    # history is partially replayed, so there is no missing reasoning_content.
    result = {"model": model, "messages": [{"role": "system", "content": system_prompt('analysis' if analyzing else 'modeling')},
        {"role": "user", "content": packed(compiled)}], "tools": tools,
        "tool_choice": "auto", "stream": False, "thinking": {"type": "enabled"},
        'reasoning_effort': reasoning_effort, "max_tokens": 16384}
    workflow = ('For an authorized modeling request, the next construction action is ' + next_action + '. '
                'This does not authorize inventing requirements. An existing model must have a current revision/epoch preview before build_geometry({}).')
    if analyzing:
        workflow = ('This is a static-analysis workflow, not a CAD construction task. analysis_setup is the already-read full setup context for this revision; reuse its exact face IDs. '
                    'Read analysis_context only if analysis_setup is missing or a genuinely different page is needed. Changing limit is not progress. '
                    'Next configure_study using established or explicitly authorized assumptions, or ask_user once for missing physical facts; then solve, assessment, finish. Do not reread setup as a substitute for choosing the next action.')
    if recovering:
        workflow += (' Preparation has stalled. Reuse analysis_setup and configure_study, or ask once for the missing physical input. Preserve confirmations already given.' if analyzing else
                     ' Preparation has stalled. Repeated tools with no new information are unavailable. Follow the next construction action if possible; otherwise report the specific blocker. Preserve confirmations already given.')
    elif not analyzing and not construction_evidence:
        workflow += ' Query native_api for the specific missing signatures. Earlier lookups may have expired after an implementation update; preparation counters are not API evidence.'
    elif not analyzing and compiled.get("planning_progress", {}).get("ready_to_build"):
        workflow += ' Several documentation lookups have completed. Reuse retained capabilities; query only a concrete missing signature needed for the next action.'
    result['messages'][0]['content'] += '\n' + workflow + ('' if analyzing else (
        iteration_prompt(module_mode)))
    if len(packed(result)) > 100000:
        raise ValueError("model request exceeds 100000-character budget")
    return result


def http_error(status, body):
    # Classify known provider diagnostics; never expose echoed keys or project data.
    message = ''
    try:
        message = json.loads(body).get('error', {}).get('message', '')
    except (ValueError, AttributeError, TypeError, UnicodeDecodeError):
        pass
    message = message.lower() if isinstance(message, str) else ''
    if status == 400 and ('tool_choice' in message or 'tool choice' in message) and ('thinking' in message or 'reasoning' in message):
        detail = '请求参数不兼容：思考模式不支持强制工具选择，请使用 tool_choice=auto。'
    else:
        detail = {400: '请求参数不被接口接受，请检查模型模式、参数和工具 schema。',
                  401: 'API 凭据无效，请检查后端配置。', 402: '账户余额不足。',
                  429: '请求超过服务限流，请稍后再试。'}.get(status, '模型服务请求失败。')
    return ValueError(f'DeepSeek HTTP {status}: {detail} 本次未执行工具，未自动重发请求。')


def client():
    return httpx.AsyncClient(timeout=httpx.Timeout(175, connect=5), follow_redirects=False, trust_env=False)


async def _send(request, key, connection):
    async with connection.stream("POST", URL, headers={"Authorization": "Bearer " + key}, json=request) as response:
        if response.status_code != 200:
            diagnostic = bytearray()
            async for chunk in response.aiter_bytes():
                diagnostic.extend(chunk[:16384 - len(diagnostic)])
                if len(diagnostic) >= 16384:
                    break
            raise http_error(response.status_code, diagnostic)
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > 262144:
                raise ValueError("DeepSeek response exceeds 256 KiB")
        return json.loads(body)


async def complete_async(request, connection):
    key = api_key()
    if not key:
        raise ValueError("DEEPSEEK_API_KEY is not configured on the backend")
    try:
        return await asyncio.wait_for(_send(request, key, connection), timeout=180)
    except (httpx.HTTPError, TimeoutError):
        raise ValueError("DeepSeek request failed or timed out; outcome may be unknown, no automatic retry") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError("DeepSeek returned invalid JSON") from None


def complete(request):
    """Synchronous single-step entry for offline scripts and explicit test stepping."""
    async def once():
        async with client() as connection:
            return await complete_async(request, connection)
    return asyncio.run(once())


def parse(response, model):
    stage = "response envelope"
    try:
        if not isinstance(response["id"], str) or not 1 <= len(response["id"]) <= 200:
            raise ValueError("invalid provider response id")
        if response["model"] != model:
            raise ValueError("unexpected provider model")
        choices = response["choices"]
        stage = "one complete tool_calls choice"
        if not isinstance(choices, list) or len(choices) != 1:
            raise ValueError("expected one complete tool response")
        stage = "consistent token usage"
        usage = {key: response["usage"][key] for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
        if any(type(value) is not int or value < 0 for value in usage.values()) or usage["total_tokens"] != usage["prompt_tokens"] + usage["completion_tokens"]:
            raise ValueError("invalid token usage")
        cached = {key: response['usage'].get(key) for key in ('prompt_cache_hit_tokens', 'prompt_cache_miss_tokens')}
        if (all(type(value) is int and 0 <= value <= usage['prompt_tokens'] for value in cached.values())
                and sum(cached.values()) == usage['prompt_tokens']):
            usage.update(cached)
        message = choices[0].get('message') or {}
        if not isinstance(message, dict):
            raise ValueError('invalid response message')
        candidate_calls = message.get('tool_calls') or []
        stats = {'content_characters':len(message['content']) if isinstance(message.get('content'), str) else 0,
                 'reasoning_characters':len(message['reasoning_content']) if isinstance(message.get('reasoning_content'), str) else 0,
                 'tool_argument_characters':sum(len(call.get('function', {}).get('arguments', '')) for call in candidate_calls
                    if isinstance(call, dict) and isinstance(call.get('function'), dict) and isinstance(call['function'].get('arguments'), str))}
        details = response['usage'].get('completion_tokens_details') or {}
        reasoning_tokens = details.get('reasoning_tokens') if isinstance(details, dict) else None
        if type(reasoning_tokens) is int and 0 <= reasoning_tokens <= usage['completion_tokens']:
            stats['reasoning_tokens'] = reasoning_tokens
        finish = choices[0]["finish_reason"]
        if finish in ("length", "stop"):
            reason = ("模型输出达到长度上限，工具调用未完整生成" if finish == "length" else "模型返回了普通文本，未按要求提交完整工具调用")
            raise IncompleteToolResponse({"response_id": response["id"], "model": model, "usage": usage,
                **stats, 'rejection_kind':'truncated_output' if finish == 'length' else 'missing_tool_call',
                "finish_reason": finish, "call_count": 0, "reason": reason + "；本轮未执行工具。请缩小本次改动范围，优先使用局部脚本替换或分零件构建，并返回一个完整调用。"})
        if finish != "tool_calls":
            raise ValueError("expected complete tool response")
        calls = choices[0]["message"]["tool_calls"]
        if isinstance(calls, list) and 1 < len(calls) <= 4 and all(isinstance(call, dict) and call.get('type') == 'function'
                and isinstance(call.get('function'), dict) and call['function'].get('name') == 'inspect_geometry' for call in calls):
            from .task_tools import Selection
            ids, selected = [], []
            try:
                for call in calls:
                    if not isinstance(call.get('id'), str) or not re.fullmatch(r'[!-~]{1,200}', call['id'], re.ASCII) or call['id'] in ids:
                        raise ValueError('invalid call identity')
                    ids.append(call['id'])
                    arguments = Selection.model_validate(json.loads(call['function']['arguments']))
                    if arguments.pick is not None:
                        raise ValueError('point picks cannot be combined')
                    selected.extend(arguments.selection)
                arguments = Selection(selection=list(dict.fromkeys(selected))).model_dump(exclude_none=True)
            except (ValueError, TypeError, KeyError):
                raise MultipleToolCalls({'response_id':response['id'], 'model':model, 'usage':usage, 'call_count':len(calls),
                                         **stats, 'rejection_kind':'multiple_calls',
                                         'reason':'多个实体测量调用无法安全合并；本轮未执行，请合并 selection 后提交一个调用。'}) from None
            return {'tool':'inspect_geometry', 'arguments':arguments}, {'response_id':response['id'], 'model':model, **stats,
                    'call_id':ids[0], 'call_ids':ids, 'call_count':len(ids), 'usage':usage}
        if isinstance(calls, list) and 1 < len(calls) <= 4 and all(isinstance(call, dict) and call.get("type") == "function" and isinstance(call.get("function"), dict) and call["function"].get("name") == "native_api" for call in calls):
            from .task_tools import ApiLookup
            lookups, ids = [], []
            try:
                for call in calls:
                    if not isinstance(call.get("id"), str) or not re.fullmatch(r"[!-~]{1,200}", call["id"], re.ASCII) or call["id"] in ids:
                        raise ValueError("invalid batched function call identity")
                    ids.append(call["id"])
                    lookups.append(ApiLookup.model_validate(json.loads(call["function"]["arguments"])).model_dump())
            except (ValueError, TypeError, KeyError):
                raise MultipleToolCalls({"response_id": response["id"], "model": model, "usage": usage,
                    **stats, 'rejection_kind':'multiple_calls',
                    "call_count": len(calls), "reason": "批量 CAD 文档调用的参数或身份无效，本轮未执行任何查询；请按 native_api schema 提交一次合法批量查询。"}) from None
            return {"tool": "native_api", "arguments": {"queries": lookups}}, {"response_id": response["id"], "model": model,
                **stats,
                "call_id": ids[0], "call_ids": ids, "call_count": len(ids), "usage": usage}
        if isinstance(calls, list) and len(calls) > 1:
            from .task_tools import TOOL_MODELS
            attempted = [call.get('function', {}).get('name') for call in calls[:8] if isinstance(call, dict) and isinstance(call.get('function'), dict)]
            raise MultipleToolCalls({"response_id": response["id"], "model": model, "usage": usage, **stats,
                                     'rejection_kind':'multiple_calls', 'attempted_tools':[name if name in TOOL_MODELS else 'unknown' for name in attempted],
                                     "call_count": len(calls)})
        stage = "exactly one function call"
        if not isinstance(calls, list) or len(calls) != 1 or calls[0]["type"] != "function":
            raise ValueError("expected one uniquely identified function call")
        stage = "valid function call id"
        if not isinstance(calls[0]["id"], str) or not re.fullmatch(r"[!-~]{1,200}", calls[0]["id"], re.ASCII):
            raise ValueError("invalid function call id")
        stage = "known tool and JSON arguments"
        item = TaskStep(tool=calls[0]["function"]["name"], arguments=json.loads(calls[0]["function"]["arguments"])).model_dump()
        return item, {"response_id": response["id"], "model": model, "call_id": calls[0]["id"], "usage": usage, **stats}
    except MultipleToolCalls:
        raise
    except (KeyError, TypeError, IndexError, ValueError):
        raise ValueError(f"invalid DeepSeek tool response ({stage}); no tools executed") from None
