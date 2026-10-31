"""Transactionally versioned cache admission avoids full scans on warm reads."""
from contextlib import contextmanager
import os
import tempfile
import unittest
from unittest.mock import patch

from backend.vision.storage import Workspace, packed
from backend.vision.retrieval import retrieve


class RetrievalGenerationTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.workspace = Workspace(self.folder.name)
        self.project = self.workspace.create({'command_id': 'project', 'idempotency_key': 'project', 'name': 'Cache'})['project_id']
        self.environment = patch.dict(os.environ, {'VISION_MEMORY_SEMANTIC': '0'})
        self.environment.start()
        with self.workspace.db() as db:
            db.execute('INSERT INTO sources VALUES(?,?,?,?)', ('source', self.project,
                       packed({'origin': 'user_task_input', 'text': 'needle original'}), 1))

    def tearDown(self):
        self.environment.stop()
        self.folder.cleanup()

    def test_warm_cache_does_not_read_source_payloads_and_direct_delete_invalidates(self):
        found, _ = retrieve(self.workspace, self.project, 'needle')
        self.assertEqual(found[0]['source_id'], 'source')
        statements = []
        original = self.workspace.db

        @contextmanager
        def trace():
            with original() as db:
                db.set_trace_callback(statements.append)
                yield db

        with patch.object(self.workspace, 'db', trace):
            cached, metadata = retrieve(self.workspace, self.project, 'needle')
        self.assertTrue(metadata['result_cache_hit'])
        self.assertEqual(cached, found)
        self.assertFalse(any('SELECT id,payload FROM sources' in sql for sql in statements))
        with self.workspace.db() as db:
            db.execute('DELETE FROM sources WHERE id=?', ('source',))
        found, metadata = retrieve(self.workspace, self.project, 'needle')
        self.assertEqual(found, [])
        self.assertFalse(metadata['result_cache_hit'])

    def test_rollback_preserves_generation_and_cached_truth(self):
        retrieve(self.workspace, self.project, 'needle')
        with self.assertRaises(RuntimeError):
            with self.workspace.db() as db:
                db.execute('UPDATE sources SET payload=? WHERE id=?',
                           (packed({'origin': 'deleted', 'text': ''}), 'source'))
                raise RuntimeError('rollback')
        found, metadata = retrieve(self.workspace, self.project, 'needle')
        self.assertTrue(metadata['result_cache_hit'])
        self.assertEqual(found[0]['text'], 'needle original')

    def test_other_connection_update_invalidates_without_in_memory_notification(self):
        retrieve(self.workspace, self.project, 'needle')
        other = Workspace(self.folder.name)
        with other.db() as db:
            db.execute('UPDATE sources SET payload=? WHERE id=?',
                       (packed({'origin': 'user_task_input', 'text': 'needle revised'}), 'source'))
        found, metadata = retrieve(self.workspace, self.project, 'needle')
        self.assertFalse(metadata['result_cache_hit'])
        self.assertEqual(found[0]['text'], 'needle revised')
