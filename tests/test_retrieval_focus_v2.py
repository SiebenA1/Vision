"""Full rerank queries, task focus, and source diversity before top-k cutoffs."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend.vision.storage import Workspace, identity, packed
from backend.vision.retrieval import retrieve, SemanticIndex
from backend.vision.task_memory import context
from test_modeling_recovery_v2 import command


class RetrievalFocusTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.ws = Workspace(self.folder.name)
        p = self.ws.create(command(name='retrieval focus'))
        self.project, self.head = p['project_id'], p['revision_id']
        Path(self.folder.name, 'ready.json').write_text('{}', encoding='utf-8')
        self.env = patch.dict('os.environ', VISION_MEMORY_SEMANTIC='0')
        self.env.start()

    def tearDown(self):
        self.env.stop()
        if hasattr(self.ws, 'semantic_index') and isinstance(self.ws.semantic_index, SemanticIndex):
            self.ws.semantic_index.client.close()
        self.folder.cleanup()

    def source(self, text, **extra):
        key = identity()
        with self.ws.db() as db:
            db.execute('INSERT INTO sources VALUES(?,?,?,?)', (key, self.project,
                packed(dict(origin='user_task_input', text=text, **extra)), time.time()))
        return key

    def test_reranker_receives_the_query_tail(self):
        self.source('安装面厚度要求')
        captured = []
        class Reranker:
            def rerank(self, query, texts, **kwargs):
                captured.append(query)
                return [1.] * len(texts)
        class Index:
            def rank(self, workspace, project, candidates, query):
                return list(candidates), Reranker()
        self.ws.semantic_index = Index()
        query = '背景描述' * 100 + '改为body-9/face-2且厚度34mm'
        with patch('backend.vision.retrieval.CACHE', Path(self.folder.name)), patch.dict('os.environ', VISION_MEMORY_SEMANTIC='1'):
            _, metadata = retrieve(self.ws, self.project, query)
        self.assertEqual(captured, [query])
        self.assertEqual(metadata['rerank_query_characters'], len(query))

    def test_repeated_background_sentences_do_not_drown_the_final_change(self):
        from backend.vision.retrieval import deduplicate_query
        query = '请结合已有模型和工程背景。' * 24 + '最后要求：安装面厚度改为34mm。'
        compacted = deduplicate_query(query)
        self.assertEqual(compacted.count('请结合已有模型和工程背景。'), 1)
        self.assertTrue(compacted.endswith('最后要求：安装面厚度改为34mm。'))

    def test_context_query_retains_latest_change_selection_and_failure(self):
        text = '建立刹车盘。' + '背景' * 2400 + '最终改为两片式浮动盘、厚度34mm'
        source = self.source(text, conversation=True, task_id='task', epoch=2,
                             reference=dict(artifact_id='a' * 64, selection=['body-9/face-2']))
        task = dict(id='task', project=self.project, revision=self.head, source=source, epoch=2)
        failed = dict(id='failed', epoch=2, revision=self.head, state='failed',
                      response=packed(dict(tool='build_geometry')), receipt='{}', error='script_error: cutter consumed')
        with patch('backend.vision.retrieval.retrieve', return_value=([], {})) as search:
            context(self.ws, task, [failed], budget=24000)
        query = search.call_args.args[2]
        self.assertIn('两片式浮动盘、厚度34mm', query)
        self.assertIn('body-9/face-2', query)
        self.assertIn('cutter consumed', query)
        self.assertLessEqual(len(query), 2000)

    def test_lexical_cutoff_applies_after_authority_and_source_filters(self):
        for _ in range(55):
            self.source('keepvalue keepvalue keepvalue', scope='geometry', artifact_id='a' * 64)
        good = self.source('keepvalue ' + 'background ' * 50)
        found, _ = retrieve(self.ws, self.project, 'keepvalue')
        self.assertEqual([item['source_id'] for item in found], [good])

    def test_long_source_does_not_fill_all_lexical_slots(self):
        self.source('fastening bolts ' * 3000)
        short = [self.source('fastening bolts ' + str(i)) for i in range(6)]
        found, metadata = retrieve(self.ws, self.project, 'fastening bolts', limit=6)
        self.assertEqual(len(found), 6)
        self.assertGreaterEqual(metadata['candidate_sources'], 6)
        self.assertTrue(set(short).intersection(item['source_id'] for item in found))

    def test_dense_grouping_retains_other_sources_and_query_tail(self):
        import numpy as np
        self.source('dense long document ' * 2000)
        for index in range(6):
            self.source('dense short source ' + str(index))
        captured = []
        class Embedding:
            def passage_embed(self, texts, **kwargs):
                return iter(np.array([1.] + [0.] * 511) for text in texts)
            def query_embed(self, query):
                captured.append(query)
                return iter([np.array([1.] + [0.] * 511)])
        class Reranker:
            def rerank(self, query, texts, **kwargs):
                return [1.] * len(texts)
        query = 'query start ' + 'x' * 500 + ' important tail'
        with patch('backend.vision.retrieval.CACHE', Path(self.folder.name)), patch.dict('os.environ', VISION_MEMORY_SEMANTIC='1'), patch(
                'backend.vision.retrieval.models', return_value=(Embedding(), Reranker())):
            found, metadata = retrieve(self.ws, self.project, query, limit=6)
        self.assertEqual(len(found), 6)
        self.assertEqual(metadata['candidate_sources'], 7)
        self.assertGreater(metadata['dense_hits'], 7)
        self.assertTrue(captured[0].endswith('important tail'))
        self.assertLessEqual(len(captured[0]), 320)

    def test_rerank_failure_is_explicit_and_keeps_diverse_fallback(self):
        for index in range(7):
            self.source('bracket ' + str(index))
        class Reranker:
            def rerank(self, query, texts, **kwargs):
                raise RuntimeError('offline rerank failure')
        class Index:
            def rank(self, workspace, project, candidates, query):
                return list(candidates), Reranker()
        self.ws.semantic_index = Index()
        with patch('backend.vision.retrieval.CACHE', Path(self.folder.name)), patch.dict('os.environ', VISION_MEMORY_SEMANTIC='1'):
            found, metadata = retrieve(self.ws, self.project, 'bracket', limit=6)
        self.assertEqual(len(found), 6)
        self.assertEqual(metadata['degraded_reason'], 'local_rerank_unavailable')
        self.assertEqual(metadata['mode'], 'hybrid')


if __name__ == '__main__':
    unittest.main()
