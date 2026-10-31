"""Request-local, provenance-scoped exact content reuse; durable evidence is untouched."""
from copy import deepcopy

from .storage import packed

POLICY = 'scoped-content/1'


def _target(context, reference, seen):
    token = packed(reference)
    if token in seen:
        raise ValueError('cyclic context content reference')
    seen = seen | {token}
    value = context[reference['section']]
    for key in ('source_id', 'turn_id', 'symbol'):
        if key in reference:
            matches = [item for item in value if item.get(key) == reference[key]]
            if len(matches) != 1:
                raise ValueError('ambiguous or missing context content owner')
            value = matches[0]
    for key in reference.get('path', []):
        if isinstance(value, dict) and set(value) == {'content_ref'}:
            value = _target(context, value['content_ref'], seen)
        value = value[key]
    value = resolve_content(context, value, seen)
    if 'slice' in reference:
        start, length = reference['slice']
        value = value[start:start + length]
    if 'slices' in reference:
        value = reference['join'].join(value[start:start + length] for start, length in reference['slices'])
    return value


def resolve_content(context, value, seen=frozenset()):
    """Resolve the local reference contract for validation and offline inspection."""
    if isinstance(value, dict):
        if set(value) == {'content_ref'}:
            return _target(context, value['content_ref'], seen)
        return {key: resolve_content(context, item, seen) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_content(context, item, seen) for item in value]
    return value


class ContentDeduplicator:
    def __init__(self, context, rows, observation_receipts=None):
        self.context, self.rows = context, rows
        self.owners = {}
        self.references = 0
        self.saved_characters = 0
        self.observation_receipts = observation_receipts or {}

    @staticmethod
    def _text_slice(full, excerpt):
        start = full.find(excerpt)
        if start >= 0:
            return {} if full == excerpt else {'slice': [start, len(excerpt)]}
        if '\n…\n' in excerpt:
            head, tail = excerpt.split('\n…\n', 1)
            first, last = full.find(head), full.rfind(tail)
            if head and tail and 0 <= first and first + len(head) <= last:
                return {'slices': [[first, len(head)], [last, len(tail)]], 'join': '\n…\n'}
        return None

    def _claim(self, holder, key, scope, location, commit):
        value = holder[key]
        if isinstance(value, dict) and 'content_ref' in value:
            return
        if not isinstance(value, (str, dict, list)) or len(packed(value)) < 80:
            return
        owners = self.owners.setdefault(scope, [])
        for original, owner_holder, owner_key, owner_location in owners:
            if owner_location == location:
                return
            if isinstance(owner_holder.get(owner_key), dict) and 'content_ref' in owner_holder[owner_key]:
                continue
            reference = dict(owner_location)
            if isinstance(value, str) and isinstance(original, str):
                selected = self._text_slice(original, value)
                if selected is None:
                    continue
                reference.update(selected)
            elif packed(value) != packed(original):
                continue
            replacement = {'content_ref': reference}
            saving = len(packed(value)) - len(packed(replacement))
            if saving <= 0:
                continue
            holder[key] = replacement
            if commit:
                self.references += 1
                self.saved_characters += saving
            return
        if commit:
            # A later admitted full source can replace an earlier excerpt's body.
            # Only text containment is promoted; differing structured facts never are.
            if isinstance(value, str):
                for original, old_holder, old_key, _ in owners:
                    if not isinstance(original, str) or old_holder.get(old_key) != original:
                        continue
                    selected = self._text_slice(value, original)
                    if selected is None:
                        continue
                    reference = dict(location)
                    reference.update(selected)
                    replacement = {'content_ref': reference}
                    saving = len(packed(original)) - len(packed(replacement))
                    if saving > 0:
                        old_holder[old_key] = replacement
                        self.references += 1
                        self.saved_characters += saving
            owners.append((deepcopy(value), holder, key, location))

    @staticmethod
    def _location(section, path=(), **identity):
        return {'section': section, **identity, 'path': list(path)}

    def _receipt(self, holder, key, location, turn_id, tool, revision, commit):
        receipt = holder[key]
        if not isinstance(receipt, dict) or 'content_ref' in receipt:
            return
        scope = ('receipt', turn_id, tool, revision)
        self._claim(holder, key, scope, location, commit)
        receipt = holder[key]
        if 'content_ref' in receipt:
            return
        for name in list(receipt):
            child_location = {**location, 'path': location['path'] + [name]}
            if name == 'geometry_summary':
                self._claim(receipt, name, ('geometry', receipt[name].get('artifact_id')), child_location, commit)
            elif name == 'text' and tool == 'read_script':
                artifact = receipt.get('artifact_id') or self.context['project'].get('geometry') or revision
                self._claim(receipt, name, ('script', artifact), child_location, commit)
            elif name == 'text' and tool == 'read_source':
                source_id = receipt.get('source_id')
                source = self.rows.get(source_id, {})
                origin = source.get('original_origin', source.get('origin'))
                self._claim(receipt, name, ('user' if origin == 'user_task_input' else 'source', source_id), child_location, commit)
            elif name == 'question' and tool == 'ask_user':
                self._claim(receipt, name, ('question', turn_id), child_location, commit)
            elif name == 'summary' and tool == 'finish':
                self._claim(receipt, name, ('assistant', turn_id), child_location, commit)
            elif name in ('faces', 'metrics', 'checks', 'job', 'text'):
                self._claim(receipt, name, (*scope, name), child_location, commit)
            elif name == 'calls' and tool == 'read_batch':
                for index, call in enumerate(receipt[name]):
                    if call.get('receipt'):
                        self._receipt(call, 'receipt', {**child_location, 'path': child_location['path'] + [index, 'receipt']},
                                      call['call_id'], call['tool'], revision, commit)

    def seed(self):
        result = self.context
        self._claim(result, 'statement', ('user', result['statement_source_id']), self._location('statement'), True)
        focus = result['task_focus']
        intent = focus['original_user_request']
        self._claim(intent, 'text', ('user', intent['source_id']),
                    self._location('task_focus', ('original_user_request', 'text')), True)
        for index, instruction in enumerate(result['retained_user_instructions']):
            self._claim(instruction, 'text', ('user', instruction['source_id']),
                        self._location('retained_user_instructions', ('text',), source_id=instruction['source_id']), True)
        reply = result.get('latest_user_reply')
        if reply:
            self._claim(reply, 'answer', ('user', reply['source_id']), self._location('latest_user_reply', ('answer',)), True)
            self._claim(reply, 'question', ('question', reply['turn_id']), self._location('latest_user_reply', ('question',)), True)
        if focus.get('geometry_summary'):
            summary = focus['geometry_summary']
            self._claim(focus, 'geometry_summary', ('geometry', summary.get('artifact_id')),
                        self._location('task_focus', ('geometry_summary',)), True)
        if result.get('working_script'):
            script = result['working_script']
            artifact = result['project'].get('geometry') or result['revision_id']
            self._claim(script, 'text', ('script', artifact), self._location('working_script', ('text',)), True)
        setup = result.get('analysis_setup')
        if setup:
            # This is the current validated setup, not the UI candidate draft.
            wrapper = {'receipt': setup}
            self._receipt(wrapper, 'receipt', self._location('analysis_setup'), setup['turn_id'],
                          'analysis_context', result['revision_id'], True)
        for section in ('latest_observation', 'latest_failure'):
            observation = result.get(section)
            if not observation:
                continue
            scope = ('error', observation['turn_id'], observation['revision_id'])
            self._claim(observation, 'error', scope, self._location(section, ('error',)), True)
            if 'receipt_excerpt' in observation:
                self._claim(observation, 'receipt_excerpt', ('excerpt', observation['turn_id'], observation['revision_id']),
                            self._location(section, ('receipt_excerpt',)), True)
            if 'receipt' in observation:
                self._receipt(observation, 'receipt', self._location(section, ('receipt',)),
                              observation['turn_id'], observation['tool'], observation['revision_id'], True)

    def item(self, section, value, commit=False):
        item = value if commit else deepcopy(value)
        if section == 'recent_tool_groups':
            self._receipt(item, 'tool_receipt', self._location(section, ('tool_receipt',), turn_id=item['turn_id']),
                          item['turn_id'], item['instruction']['tool'], item['revision_id'], commit)
        elif section in ('conversation_messages', 'historical_sources', 'long_term_memory', 'stage_memory'):
            source_id = item['source_id']
            source = self.rows.get(source_id, {})
            origin = source.get('original_origin', source.get('origin'))
            scope = ('user', source_id) if section == 'conversation_messages' or origin == 'user_task_input' else ('source', source_id)
            if section == 'stage_memory' and item.get('turn_id'):
                scope = ('assistant', item['turn_id'])
            self._claim(item, 'text', scope, self._location(section, ('text',), source_id=source_id), commit)
        elif section in ('cad_api_reference', 'cad_api_signatures'):
            runtime = (self.context.get('cad_capability_index') or {}).get('runtime_id')
            scope = ('api', runtime, item.get('version'), item['symbol'])
            for key in ('documentation', 'signature'):
                if item.get(key):
                    self._claim(item, key, scope, self._location(section, (key,), symbol=item['symbol']), commit)
        return item

    def metadata(self):
        return {'policy': POLICY, 'references': self.references, 'saved_characters': self.saved_characters}

    def finalize_observations(self):
        for section, expected in self.observation_receipts.items():
            observation = self.context.get(section)
            if not observation or not observation.get('truncated') or 'receipt_excerpt' not in observation:
                continue
            group = next((item for item in self.context['recent_tool_groups'] if item['turn_id'] == observation['turn_id']), None)
            if group is None or packed(resolve_content(self.context, group['tool_receipt'])) != packed(expected):
                continue  # A compact history index is not the complete original.
            before = len(packed(observation))
            reference = self._location('recent_tool_groups', ('tool_receipt',), turn_id=group['turn_id'])
            observation['receipt'] = {'content_ref': reference}
            observation['truncated'] = False
            observation.pop('receipt_excerpt')
            observation.pop('meaning', None)
            self.references += 1
            self.saved_characters += before - len(packed(observation))

    def admitted(self, original, projected):
        def count(value):
            if isinstance(value, dict):
                return 1 if set(value) == {'content_ref'} else sum(count(v) for v in value.values())
            return sum(count(v) for v in value) if isinstance(value, list) else 0
        self.references += count(projected) - count(original)
        self.saved_characters += len(packed(original)) - len(packed(projected))
