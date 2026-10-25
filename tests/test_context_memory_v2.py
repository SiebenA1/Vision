"""Layer budgets, memory lineage, incremental indexing and retrieval isolation."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision.engineering_memory import entries, record, available
from backend.vision.retrieval import retrieve, sync_lexical
from backend.vision.storage import packed, identity
from backend.vision.task_memory import context


def command(**fields):
    key = identity()
    return {"command_id": key, "idempotency_key": key, **fields}


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.workspace = self.app.state.workspace
        revision = self.workspace.create(command(name="memory"))
        self.project, self.head = revision["project_id"], revision["revision_id"]
        self.disabled = patch.dict("os.environ", {"VISION_MEMORY_SEMANTIC": "0"})
        self.disabled.start()

    def tearDown(self):
        self.disabled.stop()
        self.client.close()
        self.folder.cleanup()

    def source(self, text, project=None, **extra):
        source = identity()
        with self.workspace.db() as db:
            db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, project or self.project, packed({"origin": "user_task_input", "text": text, **extra}), time.time()))
        return source

    def remember(self, source, summary, supersedes=(), **extra):
        return record(self.workspace, self.project, command(expected_head=self.head, kind="requirement", summary=summary,
            source_ids=[source], supersedes=list(supersedes), scope="project", **extra))["source_id"]

    def test_layer_reservation_preserves_recent_receipt_and_source_lineage(self):
        task = {"id": "task", "project": self.project, "revision": self.head, "epoch": 30}
        for epoch in range(1, 31):
            task["source"] = self.source(("工程需求" + str(epoch)) * 1000, conversation=True, task_id="task", epoch=epoch)
        turn = {"id": "verified", "epoch": 30, "state": "succeeded", "revision": self.head,
            "response": packed({"tool": "assessment", "request": {"audit": "do_not_repeat", "source_ids": []}}),
            "receipt": packed({"value": 100, "unit": "N", "evidence": "measured"})}
        result, metadata = context(self.workspace, task, [turn])
        self.assertEqual(result["recent_tool_groups"][0]["tool_receipt"]["value"], 100)
        self.assertNotIn("do_not_repeat", packed(result))
        self.assertLessEqual(len(packed(result)), 60000)
        self.assertGreater(metadata["layers"]["conversation_messages"]["omitted_entries"], 0)
        self.assertIn(task["source"], metadata["source_ids"])

    def test_deep_lineage_and_cycles_do_not_exhaust_recursion(self):
        rows = {str(index): {"origin": "engineering_memory", "derived_from": [str(index - 1)] if index else []} for index in range(2000)}
        self.assertTrue(available(rows, "1999"))
        rows["0"]["derived_from"] = ["1999"]
        self.assertFalse(available(rows, "1999"))

    def test_explicit_correction_and_cross_project_sources(self):
        old_source = self.source("厚度3mm")
        old = self.remember(old_source, "厚度3mm")
        new_source = self.source("将厚度改为5mm")
        new = self.remember(new_source, "厚度5mm", supersedes=[old])
        states = {item["source_id"]: item["status"] for item in entries(self.workspace, self.project)}
        self.assertEqual(states, {old: "superseded", new: "active"})
        found, metadata = retrieve(self.workspace, self.project, "厚度")
        self.assertNotIn(old, [item["source_id"] for item in found])
        other = self.workspace.create(command(name="other"))["project_id"]
        foreign = self.source("其他工程尺寸", project=other)
        with self.assertRaises(LookupError):
            self.remember(foreign, "不应进入当前工程")
        self.assertTrue(metadata["degraded_reason"])

    def test_forgetting_removes_transitive_memory_chunks_and_vectors(self):
        source = self.source("机密原始尺寸100mm")
        first = self.remember(source, "长度100mm")
        second = self.remember(first, "必须保持长度100mm")
        sync_lexical(self.workspace)
        with self.workspace.db() as db:
            for row in db.execute("SELECT id FROM retrieval_chunks").fetchall():
                db.execute("INSERT INTO retrieval_vectors VALUES(?,?,?)", (row[0], "test", "[1,0]"))
        value = self.app.state.tasks.forget(self.project, command(source_id=source))
        self.assertEqual(set(value["forgotten_source_ids"]), {source, first, second})
        self.assertEqual(entries(self.workspace, self.project), [])
        self.assertEqual(retrieve(self.workspace, self.project, "长度")[0], [])
        with self.workspace.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM retrieval_vectors").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM retrieval_chunks").fetchone()[0], 0)

    def test_unchanged_index_is_not_rebuilt_and_updates_are_queued(self):
        source = self.source("固定支架螺栓")
        retrieve(self.workspace, self.project, "支架")
        with self.workspace.db() as db:
            chunk = db.execute("SELECT id FROM retrieval_chunks WHERE source=?", (source,)).fetchone()[0]
            db.execute("INSERT INTO retrieval_vectors VALUES(?,?,?)", (chunk, "test", "[1,0]"))
        retrieve(self.workspace, self.project, "支架")
        with self.workspace.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM retrieval_vectors").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM retrieval_queue").fetchone()[0], 0)
            db.execute("UPDATE sources SET payload=? WHERE id=?", (packed({"origin": "user_task_input", "text": "修改为焊接连接"}), source))
            self.assertEqual(db.execute("SELECT count(*) FROM retrieval_vectors").fetchone()[0], 0)
        self.assertIn("焊接", retrieve(self.workspace, self.project, "焊接")[0][0]["text"])

    def test_project_and_geometry_filters(self):
        own = self.source("固定支架")
        stale = self.source("固定支架旧几何", scope="geometry", artifact_id="a" * 64)
        other = self.workspace.create(command(name="other"))["project_id"]
        foreign = self.source("固定支架其他工程", project=other)
        result, _ = retrieve(self.workspace, self.project, "固定支架")
        self.assertEqual([item["source_id"] for item in result], [own])
        self.assertNotIn(stale, packed(result))
        self.assertNotIn(foreign, packed(result))

    def test_retrieval_revalidates_deletion_after_inference(self):
        source = self.source("支架厚度100mm")
        class RacingIndex:
            def rank(index, workspace, project, candidates, query):
                with workspace.db() as db:
                    db.execute("UPDATE sources SET payload=? WHERE id=?", (packed({"origin": "deleted", "text": ""}), source))
                return list(candidates), None
        self.workspace.semantic_index = RacingIndex()
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "ready.json").write_text("{}")
            with patch.dict("os.environ", {"VISION_MEMORY_SEMANTIC": "1"}), patch("backend.vision.retrieval.CACHE", Path(folder)):
                self.assertEqual(retrieve(self.workspace, self.project, "支架")[0], [])

    @unittest.skipUnless(importlib.util.find_spec("qdrant_client"), "install requirements-memory.txt")
    def test_vector_database_fusion_rerank_persistence_and_project_isolation(self):
        import numpy as np
        from backend.vision.retrieval import SemanticIndex
        source = self.source("螺栓把安装耳紧固在墙面")
        noise = self.source("蓝色外观渲染")
        class Embedding:
            def passage_embed(self, texts, **kwargs):
                return iter([np.array([1., 0.] + [0.] * 510) if "螺栓" in text else np.array([0., 1.] + [0.] * 510) for text in texts])
            def query_embed(self, query):
                return iter([np.array([1., 0.] + [0.] * 510)])
        class Reranker:
            def rerank(self, query, texts, **kwargs):
                return iter([5. if "螺栓" in text else -5. for text in texts])
        foreign = self.workspace.create(command(name="foreign vectors"))["project_id"]
        foreign_source = self.source("螺栓连接的其他工程", project=foreign)
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "ready.json").write_text("{}")
            with patch.dict("os.environ", {"VISION_MEMORY_SEMANTIC": "1"}), patch("backend.vision.retrieval.CACHE", Path(folder)), patch("backend.vision.retrieval.models", return_value=(Embedding(), Reranker())):
                foreign_found, _ = retrieve(self.workspace, foreign, "如何连接", limit=1)
                self.assertEqual(foreign_found[0]["source_id"], foreign_source)
                found, metadata = retrieve(self.workspace, self.project, "如何连接", limit=1)
                self.assertEqual(found[0]["source_id"], source)
                self.assertEqual(metadata["mode"], "hybrid_reranked")
                self.assertEqual(metadata["reranked_chunks"], 2)
                self.workspace.semantic_index.client.close()
                self.workspace.semantic_index = SemanticIndex()
                found, _ = retrieve(self.workspace, self.project, "如何连接", limit=1)
                self.assertEqual(found[0]["source_id"], source)
                self.workspace.semantic_index.client.close()

    def test_bundle_keeps_memory_and_rebuilds_derived_indexes(self):
        source = self.source("长度100mm")
        memory = self.remember(source, "长度保持100mm")
        bundle = self.client.get(f"/api/v2/projects/{self.project}/export").content
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(folder, run_jobs=False)) as client:
                reply = client.post('/api/v2/imports/bundle', content=bundle, headers={'X-Command-ID':'import','Idempotency-Key':'import'})
                self.assertEqual(reply.status_code, 201, reply.text)
                values = client.get(f"/api/v2/projects/{self.project}/memory").json()["entries"]
                self.assertEqual(values[0]["source_id"], memory)
                self.assertIn(memory, packed(client.get(f"/api/v2/projects/{self.project}/sources/search?q=长度").json()))

    def test_agent_remember_tool_is_fenced_and_checkpointed(self):
        source = self.source("厚度必须为5mm")
        task = self.app.state.tasks.create(self.project, command(expected_head=self.head, statement="保留要求", max_jobs=3,
            plan=[{"tool": "remember", "arguments": {"kind": "requirement", "summary": "厚度5mm", "source_ids": [source]}},
                  {"tool": "finish", "arguments": {"summary": "要求已记录", "outcome":"answer"}}]))["task_id"]
        with self.assertRaises(ValueError):
            self.remember(source, "运行期间不允许无围栏的记忆修改")
        for _ in range(5):
            self.app.state.tasks.step(task)
        self.assertEqual(self.app.state.tasks.get(task)["state"], "completed")
        memories = entries(self.workspace, self.project)
        self.assertEqual({item["kind"] for item in memories}, {"requirement", "stage"})
        self.assertEqual(sum(item["text"] == "厚度5mm" for item in memories), 1)
        self.assertTrue(any(item["authored_by"] == "model" for item in memories))
        remembered = next(item["source_id"] for item in memories if item["kind"] == "requirement")
        forgotten = self.app.state.tasks.forget(self.project, command(source_id=remembered))
        self.assertIn(task, forgotten["cancelled_task_ids"])
        self.assertIsNone(self.app.state.tasks.get(task)["steps"][0]["response"])
        self.assertEqual(entries(self.workspace, self.project), [])

    def test_archived_receipt_expands_and_forgetting_removes_derived_read(self):
        def run(plan):
            task = self.app.state.tasks.create(self.project, command(expected_head=self.head, statement="检查当前工程证据", max_jobs=3, plan=plan))["task_id"]
            for _ in range(5):
                self.app.state.tasks.step(task)
            self.assertEqual(self.app.state.tasks.get(task)["state"], "completed")
            return task
        original = run([{"tool": "assessment", "arguments": {}}, {"tool": "finish", "arguments": {"summary": "尚无计算证据", "outcome":"answer"}}])
        with self.workspace.db() as db:
            archived = next(row["id"] for row in db.execute("SELECT id,payload FROM sources WHERE project=?", (self.project,)) if json.loads(row["payload"])["origin"] == "tool_receipt")
            original_source = db.execute("SELECT source FROM agent_tasks WHERE id=?", (original,)).fetchone()[0]
        reader = run([{"tool": "read_source", "arguments": {"source_id": archived}}, {"tool": "finish", "arguments": {"summary": "已查阅原始历史回执", "outcome":"answer"}}])
        step = self.app.state.tasks.get(reader)["steps"][0]
        self.assertIn('"assessment"', step["receipt"]["text"])
        self.assertIn(original_source, step["receipt"]["source_ids"])
        forgotten = self.app.state.tasks.forget(self.project, command(source_id=original_source))
        self.assertIn(reader, forgotten["cancelled_task_ids"])
        self.assertIn(archived, forgotten["forgotten_source_ids"])
        self.assertIsNone(self.app.state.tasks.get(reader)["steps"][0]["receipt"])


if __name__ == "__main__":
    unittest.main()
