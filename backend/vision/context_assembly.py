"""One admission path for contributed context, provenance, reuse and layer budgets."""
from dataclasses import replace
from .context_content import ContentDeduplicator, resolve_content
from .context_contributions import CONTRIBUTORS, Omission
from .engineering_memory import available
from .storage import packed


def assemble(result, inputs, shares, budget, dependencies, contributors=None):
    contributors = CONTRIBUTORS if contributors is None else tuple(contributors)
    if len({item.name for item in contributors}) != len(contributors):
        raise ValueError('duplicate context contributor')
    dedup = ContentDeduplicator(result, inputs.rows, inputs.observation_receipts)
    dedup.seed()
    used = len(packed(result)) + 512
    if used > budget:
        raise ValueError('current task context exceeds the character budget')
    allocations = {key: int((budget - used) * share) for key, share in shares.items()}
    omitted = dict.fromkeys(shares, 0)
    sizes = dict.fromkeys(shares, 0)
    deferred, stats = [], {}

    def admit(candidate, borrow=False):
        nonlocal used, sizes
        section = candidate.section
        if section not in shares:
            raise ValueError('context contributor supplied an unknown section')
        value = dedup.item(section, candidate.value)
        cost = len(packed(value)) + 1
        if (used + cost > budget or not borrow and sizes[section] + cost > allocations[section]
                or section == 'recent_tool_groups' and len(result[section]) >= 8):
            return False
        result[section].append(value)
        dedup.admitted(candidate.value, value)
        dedup.item(section, value, commit=True)
        dedup.finalize_observations()
        dependencies.update(candidate.source_ids)
        # Promotion can replace an earlier excerpt; charge actual retained data,
        # rather than the original pre-dedup sizes or now-stale item positions.
        used = len(packed(result)) + 512
        sizes = {key: sum(len(packed(item)) + 1 for item in result[key]) for key in shares}
        return True

    availability = {}
    for contributor in contributors:
        stats[contributor.name] = {'offered': 0, 'admitted': 0, 'unavailable': 0}
        for candidate in contributor.collect(inputs):
            if candidate.section not in shares:
                raise ValueError('context contributor supplied an unknown section')
            if isinstance(candidate, Omission):
                omitted[candidate.section] += candidate.count
                continue
            stats[contributor.name]['offered'] += 1
            cited = set(candidate.source_ids) | set(candidate.value.get('source_ids', []))
            if candidate.value.get('source_id'):
                cited.add(candidate.value['source_id'])
            candidate = replace(candidate, source_ids=tuple(sorted(cited)))
            if any(not available(inputs.rows, source, availability) for source in cited):
                stats[contributor.name]['unavailable'] += 1
                continue
            if admit(candidate):
                stats[contributor.name]['admitted'] += 1
            else:
                omitted[candidate.section] += 1
                deferred.append((contributor.name, candidate))
    for name, candidate in deferred:
        if admit(candidate, borrow=True):
            omitted[candidate.section] -= 1
            stats[name]['admitted'] += 1
    order = {turn['id']: index for index, turn in enumerate(inputs.turns)}
    result['recent_tool_groups'].sort(key=lambda item: order[item['turn_id']])
    message_order = {key: index for index, key in enumerate(inputs.rows)}
    result['conversation_messages'].sort(key=lambda item: message_order[item['source_id']])
    result['context_omissions'] = {key: value for key, value in omitted.items() if value}
    # Fail before transmission if a collector or promotion produced a dangling
    # reference. This also proves that sorted histories still resolve by identity.
    resolve_content(result, result)
    if len(packed(result)) > budget:
        raise ValueError('compiled context exceeds the character budget')
    return {'layers': {key: {'allocated_characters': allocations[key], 'used_characters': sizes[key],
                            'borrowed_characters': max(0, sizes[key] - allocations[key]), 'omitted_entries': omitted[key]}
                       for key in shares}, 'contributors': stats, 'deduplication': dedup.metadata()}
