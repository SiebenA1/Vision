"""SQLite memory regression; no network, LLM, CAD or FEA runtime required."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from agent_memory import MemoryStore, Conflict


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path = Path(self.folder.name) / "memory.db"
        self.store = MemoryStore(self.path)
        self.base = {"projectId": "project-A", "snapshot": {"modelId": "model-A", "artifactId": "artifact-A", "material": "steel", "topologyIds": ["body-0/face-0"]}}

    def tearDown(self):
        self.folder.cleanup()

    def call(self, operation, **fields):
        return self.store.handle(operation, {**self.base, **fields})

    def remember(self, content="此面用于密封", target="body-0/face-0", topic="接口用途", event="user-1"):
        self.call("event", eventId=event, kind="user", payload={"text": content})
        return self.call("remember", sourceEventId=event, content=content, target=target, topic=topic, kind="requirement")

    def test_shared_object_memory_survives_process_reopen(self):
        self.remember()
        self.store = MemoryStore(self.path)
        result = self.call("context", purpose="inspection", selection=["body-0/face-0"])
        self.assertEqual(result["memories"][0]["content"], "此面用于密封")
        self.assertEqual(result["memories"][0]["epistemic"], "declared")

    def test_topology_identity_is_artifact_scoped(self):
        self.remember()
        self.base["snapshot"]["artifactId"] = "artifact-B"
        result = self.call("context", purpose="inspection", selection=["body-0/face-0"])
        self.assertEqual(result["memories"], [])
        self.assertEqual(result["excluded"][0]["reason"], "needs_rebind")
        item = self.call("list")["items"][0]
        self.call("change", id=item["id"], action="rebind", target="body-0/face-0", expectedRevision=1)
        self.assertEqual(len(self.call("context", purpose="inspection", selection=["body-0/face-0"])["memories"]), 1)

    def test_material_change_keeps_requirements(self):
        self.remember()
        self.base["snapshot"]["material"] = "aluminum"
        self.assertEqual(len(self.call("context", purpose="inspection", selection=["body-0/face-0"])["memories"]), 1)

    def test_cannot_promote_llm_or_foreign_project_to_measurement(self):
        self.call("event", eventId="assistant", kind="assistant", payload={"text": "孔径为12mm"})
        with self.assertRaises(ValueError):
            self.call("remember", sourceEventId="assistant", content="孔径为12mm", topic="孔径")
        self.remember()
        with self.assertRaises(ValueError):
            self.call("remember", sourceEventId="user-1", content="孔径为12mm", topic="孔径")
        with self.assertRaises(ValueError):
            self.call("remember", sourceEventId="user-1", content="此面用于密封", topic="用途", kind="observation")
        other = copy.deepcopy(self.base)
        other["projectId"] = "project-B"
        other["snapshot"]["modelId"] = "model-B"
        self.assertEqual(self.store.handle("context", {**other, "purpose": "chat"})["memories"], [])
        with self.assertRaises(ValueError):
            self.store.handle("remember", {**other, "sourceEventId": "user-1", "content": "此面用于密封", "topic": "用途"})

    def test_idempotent_events_and_memories(self):
        first = self.remember()
        self.assertEqual(first["id"], self.remember()["id"])
        self.assertEqual(self.call("list")["revision"], 1)
        with self.assertRaises(Conflict):
            self.call("event", eventId="user-1", kind="user", payload={"text": "different"})

    def test_conflicts_are_not_last_write_wins(self):
        old = self.remember("目标孔径10mm", target="project", topic="孔径")
        new = self.remember("目标孔径12mm", target="project", topic="孔径", event="user-2")
        items = self.call("context", purpose="chat")["memories"]
        self.assertEqual([item["status"] for item in items], ["conflicted", "conflicted"])
        with self.assertRaises(Conflict):
            self.call("change", id=new["id"], action="resolve", expectedRevision=1)
        self.call("change", id=new["id"], action="resolve", expectedRevision=2)
        items = self.call("context", purpose="chat")["memories"]
        self.assertEqual([item["id"] for item in items], [new["id"]])
        self.assertNotEqual(old["id"], new["id"])

    def test_forget_erases_derived_context_and_checkpoints(self):
        item = self.remember()
        self.call("context", purpose="chat")
        self.call("checkpoint", turnId="turn-1", signature="deepseek", status="completed", payload={"goal": "此面用于密封", "messages": []})
        self.call("change", id=item["id"], action="forget", expectedRevision=1)
        result = self.call("context", purpose="chat")
        self.assertEqual(result["epoch"], 1)
        self.assertEqual(result["memories"], [])
        self.assertIsNone(result["resume"])
        with self.store.db() as db:
            rows = db.execute("SELECT payload FROM contexts UNION ALL SELECT payload FROM events").fetchall()
            self.assertTrue(all("此面用于密封" not in row[0] for row in rows))

    def test_checkpoints_across_providers_do_not_replay_protocol(self):
        self.call("checkpoint", turnId="turn-1", signature="provider-A", status="completed", payload={"goal": "修改模型", "answer": "", "messages": [{"role": "tool", "content": "private protocol"}]})
        same = self.call("context", purpose="chat", signature="provider-A")
        self.assertIn("messages", same["resume"])
        other = self.call("context", purpose="chat", signature="provider-B")
        self.assertNotIn("messages", other["resume"])
        self.assertEqual(other["taskStatus"], "completed")
        self.call("checkpoint", turnId="turn-2", signature="provider-A", status="running", payload={"goal": "尚未完成", "messages": [{"role": "tool", "content": "incomplete protocol"}]})
        incomplete = self.call("context", purpose="chat", signature="provider-A")
        self.assertNotIn("messages", incomplete["resume"])

    def test_invalid_scope_is_rejected(self):
        self.remember()
        with self.assertRaises(ValueError):
            self.call("context", purpose="inspection", selection=["body-9/face-3"])
        other = copy.deepcopy(self.base)
        other["snapshot"]["modelId"] = "wrong-model"
        with self.assertRaises(Conflict):
            self.store.handle("list", other)

    def test_explicit_revision_keeps_old_requirement_as_history(self):
        old = self.remember("孔径要求10mm", target="project", topic="孔径")
        self.call("event", eventId="edit", kind="user", payload={"text": "孔径要求12mm"})
        self.call("remember", sourceEventId="edit", content="孔径要求12mm", topic="孔径", target="project", kind="requirement", supersedesId=old["id"], expectedRevision=1)
        items = self.call("list")["items"]
        self.assertEqual([item["status"] for item in items], ["active", "superseded"])
        self.assertEqual(len(self.call("context", purpose="chat")["memories"]), 1)

    def test_late_writes_and_old_protocol_are_rejected_after_memory_change(self):
        old = self.remember()
        self.call("checkpoint", turnId="turn-1", signature="same", status="completed", payload={"goal": "old goal", "messages": []}, expectedRevision=1)
        self.call("change", id=old["id"], action="retract", expectedRevision=1)
        result = self.call("context", purpose="chat", signature="same")
        self.assertNotIn("messages", result["resume"])
        with self.assertRaises(Conflict):
            self.call("event", eventId="late", kind="tool_succeeded", payload={"tool": "run_usd_brep"}, expectedRevision=1)

    def test_unknown_tool_execution_is_explicit_on_resume(self):
        self.call("checkpoint", turnId="turn-1", signature="same", status="running", payload={"goal": "create part"})
        self.call("event", eventId="turn-1.call-1.start", kind="tool_started", payload={"tool": "run_usd_brep"})
        result = self.call("context", purpose="chat", signature="same")
        self.assertEqual(result["executions"][0]["status"], "unknown")
        self.call("event", eventId="turn-1.call-1.finish", kind="tool_succeeded", payload={"tool": "run_usd_brep", "detail": "built artifact A"})
        result = self.call("context", purpose="chat", signature="same")
        self.assertEqual(result["executions"][0]["status"], "succeeded")

    def test_history_beyond_recent_turns_is_retrieved_with_original_source(self):
        self.call("event", eventId="early", kind="user", payload={"text": "安装孔必须保持12mm，其他区域可调整"})
        for index in range(90):
            self.call("event", eventId=f"later-{index}", kind="user", payload={"text": f"检查第{index}个显示视角"})
        result = self.call("context", purpose="chat", query="安装孔尺寸为什么保持不变")
        self.assertNotIn("early", [item["eventId"] for item in result["dialogue"]])
        self.assertIn("early", [item["eventId"] for item in result["retrievedHistory"]])
        source = self.call("source", eventId="early")
        self.assertIn("安装孔必须保持12mm", source["contentFragment"])

    def test_intent_understanding_is_separate_from_original_and_accepts_cited_revision(self):
        self.call("event", eventId="u1", kind="user", payload={"text": "做一块安装板"})
        initial = self.call("intent", eventId="i1", sourceEventId="u1", goal="设计安装板", relation="new", basedOnEventIds=[], unresolved=[])
        self.call("event", eventId="u2", kind="user", payload={"text": "厚度改成8，其他不变"})
        revised = self.call("intent", eventId="i2", sourceEventId="u2", goal="安装板厚度8mm，其余要求保留", relation="revise", basedOnEventIds=["i1", "u1"], unresolved=[])
        self.assertEqual(initial["intent"]["rootTaskId"], revised["intent"]["rootTaskId"])
        self.assertEqual(revised["intent"]["epistemic"], "agent_interpretation")
        self.assertEqual(revised["intent"]["originalRequest"], "厚度改成8，其他不变")
        self.assertNotIn("8mm", self.call("source", eventId="u2")["contentFragment"])
        with self.assertRaises(ValueError):
            self.call("intent", eventId="bad", sourceEventId="u2", goal="invented", relation="continue", basedOnEventIds=["foreign"], unresolved=[])

    def test_only_successful_executor_outputs_are_current_evidence(self):
        self.call("event", eventId="a1", kind="assistant", payload={"text": "孔径已经改好12mm"})
        self.call("event", eventId="success", kind="tool_succeeded", payload={"tool": "run_analysis", "summary": "solver completed", "state": {"result": {"maxStress": 50}}})
        self.call("event", eventId="failure", kind="tool_failed", payload={"tool": "run_usd_brep", "error": "failed"})
        result = self.call("context", purpose="chat")
        self.assertEqual(len(result["outcomes"]), 1)
        self.assertEqual(result["outcomes"][0]["validity"], "current")
        self.assertEqual(next(item for item in result["dialogue"] if item["eventId"] == "a1")["meaning"], "assistant_text_not_measurement")
        self.base["snapshot"]["material"] = "new-material"
        old = self.call("context", purpose="chat")["outcomes"][0]
        self.assertEqual(old["validity"], "historical")
        self.assertIsNone(old["state"])


if __name__ == "__main__":
    unittest.main()
