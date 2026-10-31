"""Built-in context contributors return data; admission, budget and reuse are shared."""
import ast
from collections import Counter
from dataclasses import dataclass
import json
from typing import Callable

from .engineering_memory import context_eligible, entries


@dataclass(frozen=True)
class Contribution:
    section: str
    value: dict
    source_ids: tuple = ()


@dataclass(frozen=True)
class Omission:
    section: str
    count: int
    reason: str


@dataclass(frozen=True)
class Contributor:
    name: str
    collect: Callable


@dataclass
class ContextInputs:
    workspace: object
    task: dict
    turns: list
    rows: dict
    revision: dict
    source: dict
    latest_id: str | None
    last_error: str
    preview_state: dict | None
    last_build: dict | None
    runtime_key: str | None
    capability_index: dict | None
    historical: list
    observation_receipts: dict


def execution_history(data):
    from .task_memory import compact_group, current_receipt
    task, turns, rows = data.task, data.turns, data.rows
    candidate = next((json.loads(turn.get('arguments') or '{}').get('script') for turn in reversed(turns)
                      if json.loads(turn.get('arguments') or '{}').get('script')), '')
    try:
        called = {node.func.attr for node in ast.walk(ast.parse(candidate)) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                  and node.func.value.id in ('u', 'usd_brep')}
    except SyntaxError:
        called = set()
    pages, symbols, api_groups = [], set(), 0
    runtime = data.runtime_key
    for turn in reversed(turns):
        if (turn['epoch'] != task['epoch'] and not data.source.get('conversation')) or turn['state'] != 'succeeded':
            continue
        response = json.loads(turn['response'])
        instruction = {key: response[key] for key in ('tool', 'arguments') if key in response}
        receipt = current_receipt(rows, data.revision, instruction['tool'], json.loads(turn['receipt']))
        sources = tuple(response.get('request', {}).get('source_ids', []) + receipt.get('source_ids', []))
        if instruction['tool'] == 'remember':
            memory_id = receipt.get('source_id')
            if memory_id in rows and not context_eligible(rows, memory_id, data.revision):
                continue
        if instruction['tool'] == 'native_api':
            if receipt.get('runtime_id'):
                if runtime is None:
                    from .queries import api_identity
                    runtime = api_identity()
                if receipt['runtime_id'] != runtime:
                    continue
            elif turn['epoch'] != task['epoch']:
                continue
            lookups = receipt.get('lookups', [receipt])
            for lookup in lookups:
                for entry in lookup.get('entries', []):
                    symbol = entry.get('symbol')
                    if symbol in symbols or not symbol or not (entry.get('documentation') or entry.get('signature')):
                        continue
                    name = symbol.split('.')[-1]
                    matches_error = name.replace('_', '').lower() in data.last_error.replace('_', '').lower()
                    priority = (not matches_error, turn['id'] != data.latest_id, name not in called)
                    pages.append((priority, {**entry, 'version': receipt.get('version'), 'turn_id': turn['id']}, sources))
                    symbols.add(symbol)
            if api_groups >= 2:
                continue
            api_groups += 1
            receipt = {'version': receipt.get('version'), 'lookups': [
                {key: item[key] for key in ('query', 'offset', 'total_matches', 'suggested_symbols', 'matching_symbols', 'next_offset', 'has_more') if key in item}
                | {'symbols': [entry.get('symbol') for entry in item.get('entries', [])]} for item in lookups]}
        group = {'turn_id': turn['id'], 'epoch': turn['epoch'], 'revision_id': turn['revision'],
                 'instruction': instruction, 'tool_receipt': receipt, 'current_revision': turn['revision'] == task['revision']}
        yield Contribution('recent_tool_groups', compact_group(group, latest=turn['id'] == data.latest_id), sources)
    core_symbols = {entry['symbol'] for entry in (data.capability_index or {}).get('core_signatures', [])}
    ranked = sorted(pages, key=lambda item: item[0])
    for _, page, sources in ranked[:12]:
        if page['symbol'] not in core_symbols:
            yield Contribution('cad_api_signatures', {'symbol': page['symbol'],
                'signature': page.get('signature') or page['documentation'].split('\n\n', 1)[0],
                'version': page['version'], 'turn_id': page['turn_id']}, sources)
    if len(ranked) > 12:
        yield Omission('cad_api_signatures', sum(page['symbol'] not in core_symbols for _, page, _ in ranked[12:]), 'signature limit')
    needs_pages = not data.preview_state and (data.last_build is None or data.last_build['state'] != 'succeeded'
        or data.latest_id is not None and next(json.loads(t['response'])['tool'] for t in turns if t['id'] == data.latest_id) in ('native_api', 'read_tool_result'))
    if needs_pages:
        for _, page, sources in ranked[:4]:
            yield Contribution('cad_api_reference', page, sources)
    yield Omission('cad_api_reference', max(0, len(pages) - (min(4, len(ranked)) if needs_pages else 0)), 'page selection')


def engineering_memories(data):
    memories = sorted(reversed(entries(data.workspace, data.task['project'], data.task['revision'])),
                      key=lambda memory: not memory.get('confirmed', False))
    for memory in memories:
        if not memory.get('applicable'):
            continue
        section = 'stage_memory' if memory['kind'] == 'stage' else 'long_term_memory'
        if 'tools' in memory:
            memory = {key: value for key, value in memory.items() if key != 'tools'} | {'tool_counts': dict(Counter(memory['tools']))}
        yield Contribution(section, memory, tuple(memory['source_ids']))


def retrieved_sources(data):
    from .code_modules import is_module
    indexed_turns = {turn['id'] for turn in data.turns}
    for item in data.historical:
        if is_module(data.rows.get(item['source_id'], {})):
            continue
        if item.get('origin') == 'tool_receipt' and item.get('turn_id') in indexed_turns:
            continue  # Durable turn reads provide the full original, not a second prose copy.
        yield Contribution('historical_sources', item, tuple(item.get('source_ids', [item['source_id']])))


def conversation_messages(data):
    if not data.source.get('conversation'):
        return
    for source_id, message in reversed(list(data.rows.items())):
        if (not message.get('conversation') or message.get('task_id') != data.task['id']
                or message.get('epoch', 0) > data.task['epoch'] or source_id == data.task['source']):
            continue
        reference = message.get('reference')
        if reference:
            reference = {**reference, 'current_geometry': reference['artifact_id'] == data.revision['document'].get('geometry')}
        yield Contribution('conversation_messages', {'source_id': source_id, 'role': 'user', 'text': message['text'],
            'revision_id': message.get('revision_id'), 'reference': reference}, (source_id,))


CONTRIBUTORS = (Contributor('execution-history', execution_history), Contributor('engineering-memory', engineering_memories),
                Contributor('retrieved-sources', retrieved_sources), Contributor('conversation', conversation_messages))
