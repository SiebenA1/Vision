"""Content reuse preserves provenance, complete evidence and request-local references."""
import json
import unittest
from unittest.mock import patch

from backend.vision.context_content import resolve_content
from backend.vision.context_contributions import Contribution, Contributor
from backend.vision.storage import packed
import test_modeling_recovery_v2 as fixtures


class ContextContributionsTest(unittest.TestCase):
    setUp = fixtures.ModelingRecoveryTest.setUp
    tearDown = fixtures.ModelingRecoveryTest.tearDown
    source = fixtures.ModelingRecoveryTest.source
    turn = fixtures.ModelingRecoveryTest.turn
    compile = fixtures.ModelingRecoveryTest.compile
    memory = fixtures.ModelingRecoveryTest.memory

    def test_current_statement_is_not_replayed_as_history(self):
        text = 'current-unique-intent-' + '保持准确的尺寸与开孔。' * 50
        with self.ws.db() as db:
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({'origin': 'user_task_input',
                'text': text, 'conversation': True, 'task_id': self.task['id'], 'epoch': 2}), self.task['source']))
        result, meta = self.compile()
        self.assertEqual(result['statement'], text)
        self.assertNotIn(self.task['source'], [m['source_id'] for m in result['conversation_messages']])
        self.assertEqual(packed(result).count('current-unique-intent-'), 1)
        self.assertEqual(resolve_content(result, result['task_focus']['original_user_request']['text']), text)
        self.assertGreater(meta['deduplication']['saved_characters'], 0)

    def test_full_historical_source_promotes_exact_head_tail_excerpts(self):
        text = 'original-unique-intent-' + ''.join(f'必须保留特征{i:03d}。' for i in range(300))
        original = self.source(text, conversation=True, task_id=self.task['id'], epoch=1)
        # Give the earlier source an earlier durable order than the current one.
        with self.ws.db() as db:
            db.execute('UPDATE sources SET created=0 WHERE id=?', (original,))
        result, meta = self.compile()
        resolved = resolve_content(result, result)
        self.assertEqual(resolved['task_focus']['original_user_request']['text'], text[:1200])
        self.assertEqual(resolved['retained_user_instructions'][0]['text'], text[:500] + '\n…\n' + text[-500:])
        self.assertEqual(resolved['conversation_messages'][0]['text'], text)
        self.assertEqual(packed(result).count('original-unique-intent-'), 1)
        self.assertGreater(meta['deduplication']['references'], 1)
        self.assertIn(original, meta['source_ids'])
        self.assertLessEqual(len(packed(result)), 24000)

    def test_identical_words_from_different_user_sources_do_not_merge_authority(self):
        text = '相同措辞必须保持独立来源与轮次。' * 30
        old = self.source(text, conversation=True, task_id=self.task['id'], epoch=1)
        with self.ws.db() as db:
            db.execute('UPDATE sources SET created=0 WHERE id=?', (old,))
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({'origin': 'user_task_input',
                'text': text, 'conversation': True, 'task_id': self.task['id'], 'epoch': 2}), self.task['source']))
        result, _ = self.compile()
        self.assertIsInstance(result['task_focus']['original_user_request']['text'], str)
        self.assertEqual(result['statement'], text)
        self.assertEqual(resolve_content(result, result['conversation_messages'][0]['text']), text)
        self.assertEqual(packed(result).count(text), 2)

    def test_receipt_body_has_one_owner_but_both_execution_indexes_survive(self):
        receipt = {'value': 12.5, 'unit': 'mm2', 'evidence': 'receipt-unique-evidence-' + 'measured ' * 80}
        turn = self.turn('assessment', receipt)
        result, meta = self.compile([turn])
        group = result['recent_tool_groups'][0]
        self.assertIn('content_ref', group['tool_receipt'])
        self.assertEqual(resolve_content(result, group['tool_receipt']), receipt)
        self.assertEqual(group['turn_id'], result['latest_observation']['turn_id'])
        self.assertEqual(group['expand']['turn_id'], turn['id'])
        self.assertEqual(packed(result).count('receipt-unique-evidence-'), 1)
        self.assertGreater(meta['deduplication']['saved_characters'], 0)

    def test_failed_observation_stays_failed_and_is_not_verified_by_reuse(self):
        receipt = {'recoverable': True, 'detail': 'failure-unique-detail-' + 'bad input ' * 80}
        failed = self.turn('build_geometry', receipt, state='failed', error='实际构建失败')
        result, _ = self.compile([failed])
        failure = resolve_content(result, result['latest_failure'])
        self.assertEqual(failure['state'], 'failed')
        self.assertTrue(failure['current'])
        self.assertEqual(failure['receipt'], receipt)
        self.assertEqual(packed(result).count('failure-unique-detail-'), 1)

    def test_batch_child_source_text_reuses_current_human_source(self):
        text = 'batch-source-unique-' + '这只是人的原始陈述，不是数值证明。' * 30
        with self.ws.db() as db:
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({'origin': 'user_task_input',
                'text': text, 'conversation': True, 'task_id': self.task['id'], 'epoch': 2}), self.task['source']))
        receipt = {'source_ids': [self.task['source']], 'calls': [
            {'call_id': f'call-{i}', 'tool': 'read_source', 'state': 'succeeded',
             'receipt': {'source_id': self.task['source'], 'source_ids': [self.task['source']], 'text': text}}
            for i in range(2)]}
        result, _ = self.compile([self.turn('read_batch', receipt)])
        resolved = resolve_content(result, result)
        self.assertEqual([c['receipt']['text'] for c in resolved['latest_observation']['receipt']['calls']], [text, text])
        self.assertEqual(packed(result).count('batch-source-unique-'), 1)

    def test_new_contributor_uses_shared_budget_provenance_and_dedup(self):
        source = self.source('module-source-' + 'x' * 2000)
        def collect(_):
            yield Contribution('historical_sources', {'source_id': source, 'text': 'x' * 50000}, (source,))
            yield Contribution('historical_sources', {'source_id': source, 'text': 'module-source-' + 'x' * 1000}, (source,))
        result, meta = self.compile(contributors=(Contributor('custom-source', collect),))
        self.assertEqual(len(result['historical_sources']), 1)
        self.assertEqual(meta['contributors']['custom-source']['admitted'], 1)
        self.assertEqual(meta['layers']['historical_sources']['omitted_entries'], 1)
        self.assertEqual(resolve_content(result, result), result)  # No reference to the rejected large candidate.
        self.assertIn(source, meta['source_ids'])
        with self.assertRaises(ValueError):
            self.compile(contributors=(Contributor('duplicate', collect), Contributor('duplicate', collect)))

    def test_deleted_or_foreign_source_cannot_be_admitted_by_contributor(self):
        forgotten = self.source('private content')
        with self.ws.db() as db:
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({'origin': 'deleted', 'text': ''}), forgotten))
        def collect(_):
            yield Contribution('historical_sources', {'source_id': forgotten, 'text': 'private content'}, (forgotten,))
            yield Contribution('historical_sources', {'source_id': 'foreign-source', 'text': 'foreign content'}, ('foreign-source',))
        result, meta = self.compile(contributors=(Contributor('unavailable', collect),))
        self.assertEqual(result['historical_sources'], [])
        self.assertEqual(meta['contributors']['unavailable']['unavailable'], 2)
        self.assertNotIn('private content', packed(result))

    def test_equal_receipts_at_different_versions_are_not_merged(self):
        receipt = {'measured': 'version-sensitive-result-' + 'exact observation ' * 40}
        old = self.turn('assessment', receipt)
        old['revision'] = 'historical-revision'
        current = self.turn('assessment', receipt)
        result, _ = self.compile([old, current])
        historical = next(g for g in result['recent_tool_groups'] if g['turn_id'] == old['id'])
        self.assertFalse(historical['current_revision'])
        self.assertEqual(historical['revision_id'], 'historical-revision')
        self.assertIsInstance(historical['tool_receipt']['measured'], str)
        self.assertEqual(packed(result).count('version-sensitive-result-'), 2)

    def test_memory_confirmation_does_not_merge_with_raw_human_wording(self):
        text = 'same-words-different-authority-' + '保持主体尺寸。' * 50
        with self.ws.db() as db:
            db.execute('UPDATE sources SET payload=? WHERE id=?', (packed({'origin': 'user_task_input',
                'text': text, 'conversation': True, 'task_id': self.task['id'], 'epoch': 2}), self.task['source']))
        memory_id = self.memory(text, [self.task['source']])
        result, _ = self.compile()
        memory = next(m for m in result['long_term_memory'] if m['source_id'] == memory_id)
        self.assertTrue(memory['confirmed'])
        self.assertIsInstance(memory['text'], str)
        self.assertEqual(memory['text'], result['statement'])
        self.assertEqual(packed(result).count('same-words-different-authority-'), 2)
