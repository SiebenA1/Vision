"""Layered project context with reserved evidence space and hybrid retrieval."""
import hashlib
import json

from .engineering_memory import available, context_eligible, lineage
from .storage import packed


def search(workspace, project, query, limit=6):
    from .retrieval import retrieve
    return retrieve(workspace, project, query, limit=limit)[0]


def current_receipt(rows, revision, tool, receipt):
    """Revalidate copied source text, not only new retrieval results."""
    def eligible(source):
        return source in rows and available(rows, source) and context_eligible(rows, source, revision)
    if tool == 'read_batch':
        if any(not eligible(source) for source in receipt.get('source_ids', [])):
            return {'context_status': 'source_no_longer_applicable', 'source_ids': [], 'calls': []}
        return {**receipt, 'calls': [{**call, 'receipt': current_receipt(rows, revision, call['tool'], call['receipt'])}
                                    if call.get('receipt') else call for call in receipt.get('calls', [])]}
    if tool == 'analysis_context' and (receipt.get('revision_id') != revision['revision_id'] or receipt.get('artifact_id') != revision['document'].get('geometry')):
        return {'context_status': 'stale_analysis_context', 'meaning': 'Read analysis_context again for current geometry and study.'}
    if receipt.get('modeling_check'):
        receipt = {**receipt, 'modeling_check':current_receipt(rows, revision, 'check_modeling', receipt['modeling_check'])}
    if tool in ('read_code_module','read_code_assembly','register_code_module','patch_code_module'):
        from .code_modules import eligible as module_eligible
        if any(not module_eligible(rows,key,revision) for key in receipt.get('source_ids',[])):
            return {'context_status':'source_no_longer_applicable','source_ids':[],'text':''}
    if tool=='search_code_modules':
        from .code_modules import eligible as module_eligible
        modules=[item for item in receipt.get('modules',[]) if all(module_eligible(rows,key,revision) for key in item.get('source_ids',[]))]
        return {**receipt,'modules':modules,'source_ids':list(dict.fromkeys(key for item in modules for key in item.get('source_ids',[])))}
    if tool == 'search_sources':
        sources = receipt.get('sources', [])
        kept = [item for item in sources if eligible(item.get('source_id'))]
        return {**receipt, 'sources': kept, 'omitted_sources': len(sources) - len(kept)}
    if tool == 'read_source' and not eligible(receipt.get('source_id')):
        return {'source_id': receipt.get('source_id'), 'context_status': 'source_no_longer_applicable',
                'source_ids': [], 'text': ''}
    if tool == 'remember' and not eligible(receipt.get('source_id')):
        return {'source_id': receipt.get('source_id'), 'context_status': 'source_no_longer_applicable'}
    if tool == 'read_tool_result' and any(not eligible(source) for source in receipt.get('source_ids', [])):
        return {'turn_id': receipt.get('turn_id'), 'context_status': 'source_no_longer_applicable',
                'source_ids': [], 'text': ''}
    if tool == 'check_modeling' and (receipt.get('revision_id') != revision['revision_id']
            or receipt.get('artifact_id') != revision['document'].get('geometry')
            or any(not eligible(source) for source in receipt.get('source_ids', []))):
        return {'revision_id': receipt.get('revision_id'), 'artifact_id': receipt.get('artifact_id'),
                'status': 'unknown', 'context_status':'stale_modeling_check', 'source_ids': [], 'checks': []}
    if tool == 'finish' and receipt.get('completion'):
        checked = current_receipt(rows, revision, 'check_modeling', receipt['completion'])
        return {**receipt, 'completion': checked, 'source_ids': checked.get('source_ids', [])}
    return receipt


def observation(turn, receipt):
    """A bounded mandatory observation; large original results remain expandable."""
    response = json.loads(turn['response'] or '{}')
    if response.get('tool') == 'inspect_geometry' and 'visual' in receipt:
        receipt = {key: value for key, value in receipt.items() if key != 'visual'} | {'visual_omitted':True}
    if response.get('tool') == 'native_api':
        receipt = {'runtime_id': receipt.get('runtime_id'), 'version': receipt.get('version'),
                   'lookups': [{key: item[key] for key in ('query', 'total_matches', 'has_more') if key in item} |
                               {'symbols': [entry.get('symbol') for entry in item.get('entries', [])]}
                               for item in receipt.get('lookups', [receipt])],
                   'meaning': 'Query history only; use current-runtime cad_api_signatures and cad_api_reference for builds.'}
    encoded = packed(receipt)
    result = {'turn_id': turn['id'], 'tool': response.get('tool'), 'state': turn['state'],
              'revision_id': turn['revision'], 'epoch': turn['epoch'],
              'error': (turn.get('error') or '')[:2000], 'truncated': len(encoded) > (6000 if response.get('tool') in ('solve', 'analysis_context') else 2000),
              'read_tool_result': {'turn_id': turn['id'], 'offset': 0, 'limit': 4000}}
    if result['truncated']:
        result.update(receipt_excerpt=encoded[:1000] + '\n…\n' + encoded[-500:],
                      receipt_characters=len(encoded), meaning='Incomplete excerpt; expand before relying on missing details.')
    else:
        result['receipt'] = receipt
    return result


def compact_group(group, latest=False):
    """Keep execution identity and evidence, not copies of generated scripts."""
    instruction = dict(group['instruction'])
    arguments = dict(instruction.get('arguments') or {})
    if 'script' in arguments:
        script = arguments.pop('script')
        arguments['script_reference'] = {'turn_id': group['turn_id'], 'characters': len(script),
                                         'sha256': hashlib.sha256(script.encode()).hexdigest()}
    instruction['arguments'] = arguments
    receipt = group['tool_receipt']
    tool = instruction['tool']
    if tool == 'build_geometry' and 'geometry_summary' in receipt:
        receipt = {key:value for key,value in receipt.items() if key != 'geometry_summary'} | {'geometry_summary_omitted':True}
    if tool == 'inspect_geometry' and 'visual' in receipt:
        receipt = {key: value for key, value in receipt.items() if key != 'visual'} | {'visual_omitted':True}
    if tool == 'preview_build':
        receipt = {key: receipt[key] for key in ('digest', 'base_revision_id', 'command_sha256', 'script_execution', 'notice') if key in receipt}
    elif tool == 'check_modeling':
        receipt = {key: receipt[key] for key in ('status', 'artifact_id', 'revision_id', 'source_ids') if key in receipt} | {
            'checks': [{key: check[key] for key in ('status', 'actual', 'reason') if key in check} |
                       {'name': check.get('requirement', {}).get('name')} for check in receipt.get('checks', [])]}
    elif not latest and tool in ('list_topology', 'inspect_geometry', 'read_script', 'read_source', 'read_tool_result','read_code_module'):
        receipt = {key: receipt[key] for key in ('artifact_id', 'revision_id', 'source_ids', 'context_status', 'total_matches', 'offset', 'total_characters') if key in receipt}
        receipt['historical_result_omitted'] = True
    return {**group, 'instruction': instruction, 'tool_receipt': receipt,
            'expand': {'turn_id': group['turn_id'], 'offset': 0, 'limit': 4000}}


def context(workspace, task, turns, budget=60000, *, contributors=None):
    from .retrieval import retrieve, compact_text
    revision = workspace.revision(task["project"], task["revision"])
    with workspace.db() as db:
        rows = {row["id"]: json.loads(row["payload"]) for row in db.execute(
            "SELECT id,payload FROM sources WHERE project=? ORDER BY created,id", (task["project"],))}
    source = rows[task["source"]]
    if source.get("origin") == "deleted":
        raise ValueError("task source was forgotten")
    statement, document = source.get("text", ""), revision["document"]
    reference = source.get("reference") or {}
    messages = [(key, value) for key, value in rows.items() if value.get("conversation") and value.get("task_id") == task["id"]
                and value.get("epoch", 0) <= task["epoch"] and value.get("origin") != "deleted"]
    acknowledgements = {"是", "是的", "确认", "好", "好的", "可以", "同意", "继续", "继续吧", "没结束吗", "完成了吗", "进度如何"}
    substantive = [(key, value) for key, value in messages if value.get("text", "").strip().rstrip("？！!?。") not in acknowledgements]
    kept = substantive[-3:]
    protected = [(key, value) for key, value in substantive if any(word in value.get("text", "") for word in ("不做", "不进行", "不要", "自行", "必须", "不得", "只建模"))][-3:]
    selected = {key for key, _ in kept + protected}
    instructions = [{"source_id": key, "text": value["text"] if len(value["text"]) <= 1000 else value["text"][:500] + "\n…\n" + value["text"][-500:],
                     "truncated": len(value["text"]) > 1000, "epoch": value.get("epoch")}
                    for key, value in messages if key in selected and key != task["source"]]
    last_execution = max((index for index, turn in enumerate(turns) if turn['epoch'] == task['epoch']
                          and turn['state'] == 'succeeded' and json.loads(turn['response'] or '{}').get('tool')
                          in ('build_geometry', 'configure_study', 'solve')), default=-1)
    last_error = next((turn.get('error') for turn in reversed(turns[last_execution + 1:])
                       if turn['epoch'] == task['epoch'] and turn.get('error')), '')
    query = ('当前请求：' + compact_text(statement, 900) + '\n当前对象：' + compact_text(' '.join(reference.get('selection', [])), 500)
             + '\n近期要求：' + compact_text(' '.join(value['text'] for key, value in kept if key != task['source']), 350)
             + '\n当前失败：' + compact_text(last_error or '', 180))
    historical, retrieval = retrieve(workspace, task["project"], query or "工程需求", revision=task["revision"])
    latest_preview = next((turn for turn in reversed(turns) if turn['epoch'] == task['epoch']
                           and turn['revision'] == task['revision'] and turn['state'] == 'succeeded'
                           and json.loads(turn['response'] or '{}').get('tool') == 'preview_build'), None)
    preview_state = ({'turn_id': latest_preview['id'], 'revision_id': task['revision'], 'epoch': task['epoch'],
                      'digest': json.loads(latest_preview['receipt'])['digest']} if latest_preview else None)
    runtime_key, capability_index = None, None
    capability_sources = []
    for turn in reversed(turns):
        if (turn['state'] != 'succeeded' or not turn.get('receipt')
                or (turn['epoch'] != task['epoch'] and not source.get('conversation'))
                or json.loads(turn['response'] or '{}').get('tool') != 'native_api'):
            continue
        receipt = json.loads(turn['receipt'])
        if not receipt.get('capability_index') or not receipt.get('runtime_id'):
            continue
        from .queries import api_identity
        runtime_key = api_identity()
        if receipt['runtime_id'] == runtime_key:
            capability_index = {**receipt['capability_index'], 'runtime_id': runtime_key, 'turn_id': turn['id']}
            capability_sources = json.loads(turn['response']).get('request', {}).get('source_ids', [])
            break
    latest_check, check_receipt = None, {}
    for turn in reversed(turns):
        if turn['state'] != 'succeeded':
            continue
        receipt = json.loads(turn.get('receipt') or '{}')
        tool = json.loads(turn['response'] or '{}').get('tool')
        candidate_check = receipt if tool == 'check_modeling' else receipt.get('modeling_check', {})
        if candidate_check.get('revision_id') == task['revision']:
            latest_check, check_receipt = turn, candidate_check
            break
    check_sources = check_receipt.get('source_ids', [])
    goal_items = document.get('modeling_requirements', [])
    requirement_sources_current = all(available(rows, key) and context_eligible(rows, key, revision)
                                      for item in goal_items for key in item['source_ids'])
    valid_check = (latest_check and check_receipt.get('artifact_id') == document.get('geometry')
                   and requirement_sources_current and all(available(rows, key) and context_eligible(rows, key, revision) for key in check_sources))
    completion_state = {'artifact_id': document.get('geometry'), 'revision_id': task['revision'],
                        'status': (check_receipt['status'] if valid_check else 'not_built' if not document.get('geometry') else
                                   'needs_review' if not requirement_sources_current else 'unverified'),
                        'requirement_sources_current': requirement_sources_current,
                        'check_turn_id': latest_check['id'] if valid_check else None,
                        'scope': 'registered_modeling_requirements_only'}
    observations = [turn for turn in turns if turn['state'] in ('succeeded', 'failed', 'rejected') and turn.get('response')
                    and (source.get('conversation') or turn['epoch'] == task['epoch'])]
    latest = observations[-1] if observations else None
    failure = next((turn for turn in reversed(observations) if turn['state'] == 'failed'), None)
    latest_receipt = current_receipt(rows, revision, json.loads(latest['response']).get('tool'),
                                    json.loads(latest['receipt'] or '{}')) if latest else None
    failure_receipt = current_receipt(rows, revision, json.loads(failure['response']).get('tool'),
                                     json.loads(failure['receipt'] or '{}')) if failure else None
    resolved_by = None
    if failure:
        failed_tool = json.loads(failure['response']).get('tool')
        resolved_by = next((turn['id'] for turn in observations[observations.index(failure) + 1:]
                            if turn['state'] == 'succeeded' and json.loads(turn['response']).get('tool') == failed_tool), None)
    reply = None
    reply_sources = []
    for key, message in reversed(messages):
        question = next((turn for turn in reversed(turns) if turn['id'] == message.get('reply_to_turn_id')
                         and turn['state'] == 'succeeded' and turn.get('receipt')
                         and json.loads(turn['response'] or '{}').get('tool') == 'ask_user'), None)
        if question:
            reply = {'source_id': key, 'turn_id': question['id'], 'question': json.loads(question['receipt'])['question'],
                     'answer': message['text'][:1000], 'answer_truncated': len(message['text']) > 1000,
                     'meaning': 'Original question and human reply; interpret the reply, do not assume every reply is consent.'}
            reply_sources = [key, *json.loads(question['response']).get('request', {}).get('source_ids', [])]
            break
    intent_id, intent = messages[0] if messages else (task['source'], source)
    unresolved = [index for index, item in enumerate(goal_items) if not valid_check or
                  next((check['status'] for check in check_receipt.get('checks', [])
                        if check.get('requirement', {}).get('name') == item['name']), 'unknown') != 'pass']
    last_build = next((turn for turn in reversed(turns) if turn['epoch'] == task['epoch']
                       and json.loads(turn['response'] or '{}').get('tool') == 'build_geometry'), None)
    focus = {'original_user_request': {'source_id': intent_id, 'text': intent.get('text', '')[:1200],
                                      'truncated': len(intent.get('text', '')) > 1200},
             'unresolved_requirement_indices': unresolved,
             'last_build_state': last_build['state'] if last_build else None,
             'authority': 'User wording and accepted choices define intent. Registered criteria are model interpretations, not permission to drop or simplify requested features.'}
    failed_modules=json.loads(last_build.get('arguments') or '{}').get('module_assembly') if last_build and last_build['state']=='failed' else None
    if failed_modules:
        focus['failed_modules']=[{key:item[key] for key in ('component_id','module_id','code_revision')} for item in failed_modules[:8]]
        focus['failed_module_count']=len(failed_modules)
    if document.get('geometry'):
        try:
            current_artifact = workspace.artifacts.manifest(document['geometry'])
            focus['current_parameters'] = current_artifact.get('parameters', {})
            focus['current_parts'] = {body['name']:body['id'] for body in current_artifact.get('bodies', [])}
            if current_artifact.get('files', {}).get('source.py'):
                focus['script_revision'] = {'artifact_id':document['geometry'], 'sha256':current_artifact['files']['source.py']}
            from .modeling import geometry_summary
            focus['geometry_summary'] = geometry_summary(current_artifact)
            if current_artifact.get('module_execution'):
                focus['module_assembly_reference'] = {'artifact_id':document['geometry'],
                    'component_ids':[item['component_id'] for item in current_artifact['module_execution']['components']]}
        except FileNotFoundError:
            pass  # Imported/unavailable artifacts have no reusable edit inputs.
    from .code_modules import search as search_modules
    catalog=search_modules(workspace,task['project'],{'limit':4})
    if catalog['modules']:
        focus['module_catalog']=[{key:item[key] for key in ('module_id','code_revision','description','tags','source_ids','validation')} |
                                 {'parameter_names':list(item['parameters'])[:8], 'parameter_count':len(item['parameters']),
                                  'interface_excerpt':True} for item in catalog['modules']]
        while len(packed(focus['module_catalog']))>2600 and len(focus['module_catalog'])>1:focus['module_catalog'].pop()
    latest_solve = next((turn for turn in reversed(observations) if turn['state'] == 'succeeded' and json.loads(turn['response']).get('tool') == 'solve'), None)
    solve_evidence = None
    if latest_solve:
        from .task_tools import analysis_receipt
        solve_receipt = json.loads(latest_solve.get('receipt') or '{}')
        if solve_receipt.get('job', {}).get('state') == 'succeeded':
            solve_evidence = {**analysis_receipt(solve_receipt['job'], solve_receipt.get('reused', False)),
                              'current_revision': latest_solve['revision'] == task['revision'], 'epoch': latest_solve['epoch'], 'turn_id': latest_solve['id']}
            if not solve_evidence['current_revision']:
                solve_evidence['next_action'] = 'Historical result: the project revision changed. Verify current physical inputs before reusing or solving.'
    setup_turn = next((turn for turn in reversed(observations) if turn['state'] == 'succeeded'
                       and turn['epoch'] == task['epoch'] and turn['revision'] == task['revision']
                       and json.loads(turn['response']).get('tool') == 'analysis_context'), None)
    analysis_setup = None
    if setup_turn:
        setup = json.loads(setup_turn.get('receipt') or '{}')
        if setup.get('artifact_id') == document.get('geometry'):
            analysis_setup = {key: value for key, value in setup.items() if key not in ('candidate_study', 'saved_study')}
            analysis_setup.update(epoch=task['epoch'], turn_id=setup_turn['id'])
    result = {"revision_id": task["revision"], "epoch": task["epoch"], "statement": statement,
        'task_focus': focus, 'latest_analysis': solve_evidence,
        'analysis_setup': analysis_setup,
        'model_completion_state': completion_state,
        'cad_capability_index': capability_index,
        'current_reference': {**reference, 'current_geometry': reference.get('artifact_id') == document.get('geometry')} if reference else None,
        'latest_user_reply': reply, 'latest_observation': observation(latest, latest_receipt) if latest else None,
        'latest_failure': {**observation(failure, failure_receipt), 'current': resolved_by is None,
                           'resolved_by_turn_id': resolved_by} if failure else None,
        'context_omissions': {},
        "latest_build_preview": preview_state,
        "statement_source_id": task["source"], "project": document,
        'analysis_candidate': {'study': source['analysis_draft'], 'current_revision': source.get('revision_id') == task['revision'],
                               'authority': 'UI candidate settings, not confirmation of actual material/load/mounting.'} if source.get('analysis_draft') else None,
        "long_term_memory": [], "stage_memory": [], "historical_sources": [], "recent_tool_groups": [],
        "conversation_messages": [], "cad_api_reference": [], "cad_api_signatures": [], "retained_user_instructions": instructions}
    # One active edit input may be necessary across intervening API queries.
    # It is a working set, not a replay of all scripts from the history.
    working_turn, working_text, working_offset, working_total = None, '', 0, 0
    if not preview_state and last_build and last_build['state'] == 'failed' and not failed_modules:
        working_turn = last_build
        working_text = json.loads(last_build.get('arguments') or '{}').get('script', '')
        working_total = len(working_text)
    elif not preview_state and document.get('geometry') and not failed_modules and not focus.get('module_assembly_reference'):
        working_turn = next((turn for turn in reversed(turns) if turn['state'] == 'succeeded'
                             and (turn['revision'] == task['revision'] or
                                  json.loads(turn.get('receipt') or '{}').get('artifact_id') == document.get('geometry'))
                             and json.loads(turn['response'] or '{}').get('tool') == 'read_script'), None)
        if working_turn:
            read = json.loads(working_turn['receipt'])
            working_text, working_offset = read.get('text', ''), read.get('offset', 0)
            working_total = read.get('total_characters', len(working_text))
    if working_turn and working_text:
        capacity = max(0, min(6000, budget - len(packed(result)) - 1800))
        result['working_script'] = {'turn_id': working_turn['id'], 'revision_id': working_turn['revision'],
                                    'text': working_text[:capacity], 'offset': working_offset, 'total_characters': working_total,
                                    'truncated': len(working_text) > capacity or working_offset > 0 or len(working_text) < working_total,
                                    'expand': {'turn_id':working_turn['id'], 'offset':0, 'limit':4000}}
    shares = {"recent_tool_groups": .30, "long_term_memory": .15, "stage_memory": .06,
              "historical_sources": .10, "conversation_messages": .14, "cad_api_reference": .16, "cad_api_signatures": .09}
    recent_tools = [json.loads(turn["response"] or "{}").get("tool") for turn in reversed(turns) if turn["epoch"] == task["epoch"] and turn["state"] == "succeeded"]
    phase = "analysis" if next((tool for tool in recent_tools if tool not in ("remember", "search_sources", "read_source", "read_tool_result", "list_topology", "inspect_geometry", "read_batch")), None) in ("analysis_context", "configure_study", "solve", "assessment", "beam_reference", "solver_validation") else "modeling"
    result['workflow_phase'] = phase
    if phase == "analysis":
        shares = {"recent_tool_groups":.40,"long_term_memory":.20,"stage_memory":.05,"historical_sources":.13,
                  "conversation_messages":.17,"cad_api_reference":.03,"cad_api_signatures":.02}
    goal_sources = {source for item in goal_items for source in item['source_ids'] if available(rows, source)}
    dependencies = {task["source"], *(item["source_id"] for item in instructions), *reply_sources, *goal_sources,
                    *(check_sources if valid_check else []), *capability_sources, intent_id}
    dependencies.update(catalog['source_ids'])
    if result.get('working_script'):
        dependencies.update(json.loads(working_turn['response']).get('request', {}).get('source_ids', []))
    if latest:
        dependencies.update(json.loads(latest['response']).get('request', {}).get('source_ids', []))
        dependencies.update(latest_receipt.get('source_ids', []))
        dependencies.update(item['source_id'] for item in latest_receipt.get('sources', []))
    if failure:
        dependencies.update(json.loads(failure['response']).get('request', {}).get('source_ids', []))
    from .context_contributions import ContextInputs
    from .context_assembly import assemble
    inputs = ContextInputs(workspace, task, turns, rows, revision, source, latest['id'] if latest else None,
                           last_error or '', preview_state, last_build, runtime_key, capability_index, historical,
                           {'latest_observation': latest_receipt, 'latest_failure': failure_receipt})
    assembly = assemble(result, inputs, shares, budget, dependencies, contributors)
    encoded = packed(result)
    return result, {"characters": len(encoded), "budget_characters": budget,
        "estimated_text_tokens_upper_bound": len(encoded.encode("utf-8")), "token_estimate_method": "utf8_bytes_not_provider_tokenizer",
        "sha256": hashlib.sha256(encoded.encode()).hexdigest(), "source_ids": lineage(rows, dependencies),
        "phase": phase, "retrieval": retrieval, **assembly}
