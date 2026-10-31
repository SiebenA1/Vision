"""Bounded independent reads, checkpointed inside the existing durable turn."""
import json
from typing import Literal

from pydantic import Field

from .contracts import Contract
from .storage import Conflict, Missing, packed
from .queries import QueryUnavailable

READ_TOOLS = ('list_topology', 'read_script', 'read_source', 'read_tool_result')


class ReadCall(Contract):
    tool: Literal['list_topology', 'read_script', 'read_source', 'read_tool_result']
    arguments: dict = Field(default_factory=dict)


class ReadBatch(Contract):
    calls: list[ReadCall] = Field(min_length=1, max_length=4)


def prepare_calls(task, arguments, turns, workspace):
    from .task_tools import prepare
    calls = ReadBatch.model_validate(arguments).model_dump()['calls']
    for call in calls:
        args = call['arguments']
        bound = 8 if call['tool'] == 'list_topology' else 2000
        if 'limit' not in args:
            args['limit'] = bound
        if type(args['limit']) is not int or not 1 <= args['limit'] <= bound:
            raise ValueError('batch reads allow at most 8 topology entries or 2000 text characters per call')
        call['arguments'] = prepare(task, call, turns, workspace)
    return calls


def execute_batch(workspace, queries, task, arguments):
    from .task_tools import execute
    from .engineering_memory import available
    calls = prepare_calls(task, arguments, [], workspace)
    with workspace.db() as db:
        parent = db.execute("SELECT id,receipt FROM agent_turns WHERE task=? AND epoch=? AND state='executing' "
                            'ORDER BY ordinal DESC LIMIT 1', (task['id'], task['epoch'])).fetchone()
    if parent is None:
        raise Conflict('read batch requires a durable executing turn')
    turn_id = parent['id']
    result = json.loads(parent['receipt']) if parent['receipt'] else {
        'batch_schema': 1, 'revision_id': task['revision'], 'source_ids': [],
        'calls': [{'call_id': f'{turn_id}:{index}', **call, 'state': 'not_started'} for index, call in enumerate(calls)]}
    if [(c['tool'], c['arguments']) for c in result['calls']] != [(c['tool'], c['arguments']) for c in calls]:
        raise Conflict('read batch inputs changed after checkpoint')

    def checkpoint():
        with workspace.db() as db:
            current = db.execute('SELECT epoch,state,project FROM agent_tasks WHERE id=?', (task['id'],)).fetchone()
            if (not current or current['epoch'] != task['epoch'] or current['state'] != 'executing'
                    or workspace._revision(db, task['project'])['revision_id'] != task['revision']):
                raise Conflict('read batch cancelled or project changed')
            rows = {row['id']: json.loads(row['payload']) for row in
                    db.execute('SELECT id,payload FROM sources WHERE project=?', (task['project'],))}
            if any(not available(rows, source) for source in result['source_ids']):
                raise Conflict('read batch source was forgotten')
            db.execute("UPDATE agent_turns SET receipt=? WHERE id=? AND state='executing'", (packed(result), turn_id))

    # A crash while a child was executing is ambiguous. Keep earlier results,
    # pause the turn, and never silently rerun the interrupted child.
    if any(call['state'] == 'executing' for call in result['calls']):
        for call in result['calls']:
            if call['state'] in ('executing', 'not_started'):
                call.update(state='interrupted', error='batch interrupted; no automatic replay')
        checkpoint()
        raise ValueError('read batch interrupted; inspect saved results before correcting')

    for call in result['calls']:
        if call['state'] != 'not_started':
            continue
        call['state'] = 'executing'
        checkpoint()
        try:
            receipt = execute(workspace, queries, task, call['tool'], call['arguments'])
            if len(packed(receipt)) > 3000:
                raise ValueError('read result exceeds batch limit; use the individual tool or a smaller range')
            call.update(state='succeeded', receipt=receipt)
            sources = receipt.get('source_ids', []) + ([receipt['source_id']] if receipt.get('source_id') else [])
            result['source_ids'] = sorted(set(result['source_ids']) | set(sources))
            if len(packed(result)) > 15000:
                call.pop('receipt')
                raise ValueError('total read batch result exceeds 15000 characters; use individual tools')
        except (ValueError, Missing, OSError, QueryUnavailable) as error:
            call.update(state='failed', error=str(error)[:500])
        checkpoint()
    result['expand'] = {'turn_id': turn_id, 'offset': 0, 'limit': 4000}
    return result
