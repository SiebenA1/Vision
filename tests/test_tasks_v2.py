"""Local task protocol tests; no external model or network provider is simulated."""
import importlib.util
from contextlib import closing
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if importlib.util.find_spec("fastapi") is None:
    raise unittest.SkipTest("install backend/requirements.txt")
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision.storage import Workspace, packed
from backend.vision.task_tools import execute


def command(key, **fields):
    return {"command_id": key, "idempotency_key": key, **fields}


def step(tool, **arguments):
    return {"tool": tool, "arguments": arguments}


STUDY = {"material": {"E": 210000, "nu": .3, "rho": 7850, "yieldStrength": 235},
         "supports": [{"id": "fixed", "face": "x-min"}], "loads": [{"id": "load", "face": "x-max", "vector": [1, 0, 0], "magnitude": 100}], "mesh_size": 4}


class ProcessCrash(BaseException):
    pass


class TaskProtocolTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.workspace, self.tasks = self.app.state.workspace, self.app.state.tasks
        revision = self.client.post("/api/v2/projects", json=command("project", name="Task project")).json()
        self.project, self.head = revision["project_id"], revision["revision_id"]
        self.base = f"/api/v2/projects/{self.project}"

    def tearDown(self):
        self.client.close()
        self.folder.cleanup()

    def create(self, plan, statement="悬臂梁安装面要求", key="task"):
        response = self.client.post(self.base + "/tasks", json=command(key, expected_head=self.workspace.revision(self.project)["revision_id"], statement=statement, plan=plan))
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()["task_id"]

    def advance(self, task, count=8):
        for _ in range(count):
            self.tasks.step(task)
        return self.tasks.get(task)

    def test_pause_correction_history_and_command_idempotency(self):
        task = self.create([step("search_sources", query="悬臂梁"), step("ask_user", question="请明确合力大小"), step("solve")])
        paused = self.advance(task)
        self.assertEqual(paused["state"], "waiting_user")
        self.assertEqual(paused["summary"], "请明确合力大小")
        self.assertEqual(paused["jobs"], 0)
        request = command("correct", expected_head=self.head, expected_epoch=1, statement="只检查当前证据", plan=[step("assessment")])
        corrected = self.client.post(f"/api/v2/tasks/{task}/correct", json=request)
        self.assertEqual(corrected.status_code, 200, corrected.text)
        self.assertEqual(self.client.post(f"/api/v2/tasks/{task}/correct", json=request).json(), corrected.json())
        self.assertEqual(self.advance(task)["state"], "completed")
        self.assertEqual(self.tasks.get(task)["epoch"], 2)
        self.assertEqual(self.client.post(f"/api/v2/tasks/{task}/cancel", json=command("old", expected_epoch=1)).status_code, 409)
        context = self.client.get(f"/api/v2/tasks/{task}/context").json()
        self.assertFalse(context["external_transmission"])
        self.assertEqual(context["context"]["epoch"], 2)
        self.assertLessEqual(context["metadata"]["characters"], context["metadata"]["budget_characters"])

    def test_correction_between_checkpoint_and_write_is_fenced(self):
        task = self.create([step("build_geometry", script="result=u.create_box((0,0,0),1,1,1)")])
        self.tasks.step(task)
        def corrected_then_execute(workspace, queries, snapshot, tool, arguments):
            self.tasks.change(task, command("correction", expected_head=self.head, expected_epoch=1, statement="停止建模，只检查证据", plan=[step("assessment")]), correct=True)
            return execute(workspace, queries, snapshot, tool, arguments)
        with patch("backend.vision.tasks.execute", side_effect=corrected_then_execute):
            self.tasks.step(task)
        self.assertEqual(self.client.get(self.base + "/jobs").json(), [])
        self.assertEqual(self.tasks.get(task)["epoch"], 2)
        self.assertEqual(self.advance(task)["state"], "completed")

    def crash_after_enqueue(self):
        task = self.create([step("build_geometry", script="result=u.create_box((0,0,0),1,1,1)")])
        self.tasks.step(task)
        def enqueue_then_crash(*arguments):
            execute(*arguments)
            raise ProcessCrash()
        with patch("backend.vision.tasks.execute", side_effect=enqueue_then_crash):
            with self.assertRaises(ProcessCrash):
                self.tasks.step(task)
        return task

    def test_recovery_uses_existing_tool_receipt_without_duplicate_job(self):
        task = self.crash_after_enqueue()
        self.tasks.step(task)
        self.assertEqual(self.tasks.get(task)["state"], "waiting_job")
        self.assertEqual(len(self.client.get(self.base + "/jobs").json()), 1)
        self.tasks.change(task, command("stop", expected_epoch=1))
        self.assertEqual(self.client.get(self.base + "/jobs").json()[0]["state"], "cancelled")

    def test_stale_correction_keeps_epoch_and_owned_job(self):
        task = self.crash_after_enqueue()
        renamed = self.client.post(self.base + "/rename", json=command("rename", expected_head=self.head, name="New head"))
        self.assertEqual(renamed.status_code, 200, renamed.text)
        response = self.client.post(f"/api/v2/tasks/{task}/correct", json=command("correct", expected_head=self.head,
            expected_epoch=1, statement="Check evidence", plan=[step("assessment")]))
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.tasks.get(task)["epoch"], 1)
        self.assertEqual(self.client.get(self.base + "/jobs").json()[0]["state"], "queued")

    def test_cancellation_and_forgetting_cannot_follow_foreign_project_references(self):
        other = self.client.post("/api/v2/projects", json=command("other", name="Other")).json()
        other_base = f"/api/v2/projects/{other['project_id']}"
        response = self.client.post(other_base + "/tasks", json=command("other-task", expected_head=other["revision_id"],
            statement="Foreign task", plan=[step("build_geometry", script="result=u.create_box((0,0,0),1,1,1)")]))
        foreign = response.json()["task_id"]
        self.advance(foreign, 2)
        foreign_job = self.client.get(other_base + "/jobs").json()[0]
        task = self.create([step("assessment")])
        self.advance(task, 2)
        with self.workspace.db() as db:
            # Imported/untrusted source metadata and checkpoint receipts must
            # never widen task ownership to a different project.
            db.execute("UPDATE agent_turns SET job=? WHERE task=?", (foreign_job["id"], task))
            source = self.tasks.row(db, task)["source"]
            db.execute("UPDATE sources SET payload=? WHERE id=?", (packed({"origin": "imported_source", "text": "local", "task_id": foreign}), source))
        self.tasks.change(task, command("stop-local", expected_epoch=1))
        self.tasks.forget(self.project, command("forget-local", source_id=source))
        self.assertEqual(self.tasks.get(foreign)["epoch"], 1)
        self.assertEqual(self.client.get(other_base + "/jobs").json()[0]["state"], "queued")

    def test_correction_cancels_job_even_before_checkpoint_link_is_saved(self):
        task = self.crash_after_enqueue()
        self.tasks.change(task, command("correct", expected_head=self.head, expected_epoch=1, statement="不要构建", plan=[step("assessment")]), correct=True)
        self.assertEqual(self.client.get(self.base + "/jobs").json()[0]["state"], "cancelled")
        self.assertEqual(self.advance(task)["state"], "completed")
        self.assertEqual(self.workspace.revision(self.project)["revision_id"], self.head)

    def test_source_scope_forgetting_and_bundle_redaction(self):
        phrase = "必须保留的安装孔位置机密来源"
        task = self.create([step("search_sources", query="安装孔位置"), step("ask_user", question=phrase)], statement=phrase)
        self.advance(task)
        consumer = self.create([step("search_sources", query="安装孔位置")], statement="检索先前安装要求", key="consumer")
        self.advance(consumer)
        source = self.tasks.get(task)["source"]
        other = self.client.post("/api/v2/projects", json=command("other", name="Other")).json()
        self.assertEqual(self.client.get(f"/api/v2/projects/{other['project_id']}/sources/search", params={"q": "安装孔位置"}).json()["sources"], [])
        self.assertTrue(self.client.get(self.base + "/sources/search", params={"q": "安装孔位置"}).json()["sources"])
        response = self.client.post(self.base + "/sources/forget", json=command("forget", source_id=source))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.tasks.get(task)["state"], "cancelled")
        self.assertEqual(self.tasks.get(consumer)["state"], "cancelled")
        compiled = self.client.get(f"/api/v2/tasks/{consumer}/context")
        self.assertEqual(compiled.status_code, 200, compiled.text)
        self.assertNotIn(phrase, compiled.text)
        self.assertEqual(self.tasks.inputs(task)["statement"], "")
        retrieved = self.client.get(self.base + "/sources/search", params={"q": "安装孔位置"}).json()["sources"]
        self.assertFalse(any(item["source_id"] == source or phrase in item["text"] for item in retrieved))
        bundle = self.client.get(self.base + "/export")
        self.assertEqual(bundle.status_code, 200, bundle.text[:100] if bundle.status_code != 200 else '')
        with zipfile.ZipFile(io.BytesIO(bundle.content)) as file:
            self.assertNotIn(phrase, file.read("project.json").decode())
        response = self.client.post(f"/api/v2/tasks/{task}/correct", json=command("revive", expected_head=self.head,
            expected_epoch=self.tasks.get(task)["epoch"], statement="New statement", plan=[step("assessment")]))
        self.assertEqual(response.status_code, 409, response.text)

    def test_correction_cannot_exceed_global_active_task_budget(self):
        task = self.create([step("ask_user", question="Pause here")])
        self.advance(task)
        for index in range(8):
            self.create([step("assessment")], key=f"active-{index}")
        response = self.client.post(f"/api/v2/tasks/{task}/correct", json=command("resume-over-budget", expected_head=self.head,
            expected_epoch=1, statement="Resume", plan=[step("assessment")]))
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.tasks.get(task)["state"], "waiting_user")
        self.assertEqual(self.tasks.get(task)["epoch"], 1)

    def test_forgetting_between_retrieval_and_checkpoint_does_not_restore_excerpt(self):
        phrase = "忘记来源与工具检查点之间的敏感原文"
        source_task = self.create([step("assessment")], statement=phrase)
        source = self.tasks.get(source_task)["source"]
        consumer = self.create([step("search_sources", query=phrase)], statement="检索历史来源", key="consumer")
        self.tasks.step(consumer)
        def forget_after_read(*arguments):
            receipt = execute(*arguments)
            self.tasks.forget(self.project, command("forget-race", source_id=source))
            return receipt
        with patch("backend.vision.tasks.execute", side_effect=forget_after_read):
            self.tasks.step(consumer)
        task = self.tasks.get(consumer)
        self.assertEqual(task["state"], "waiting_user")
        self.assertIsNone(task["steps"][0]["receipt"])
        compiled = self.client.get(f"/api/v2/tasks/{consumer}/context")
        self.assertNotIn(phrase, compiled.text)

    def test_export_restores_tasks_paused_and_preserves_create_receipt(self):
        plan = [step("build_geometry", script="raise RuntimeError('import must not execute')")]
        task = self.create(plan)
        exported = self.client.get(self.base + "/export").content
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder, run_jobs=False)) as restored:
                response = restored.post("/api/v2/imports/bundle", headers={"X-Command-ID": "restore", "Idempotency-Key": "restore"}, content=exported)
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual(restored.get(f"/api/v2/tasks/{task}").json()["state"], "waiting_user")
                repeated = restored.post(self.base + "/tasks", json=command("task", expected_head=self.head, statement="悬臂梁安装面要求", plan=plan))
                self.assertEqual(repeated.json()["task_id"], task)
                self.assertEqual(restored.get(self.base + "/jobs").json(), [])

    def test_schema2_upgrade_is_backed_up(self):
        with self.workspace.db() as db:
            db.execute("DROP TABLE agent_turns")
            db.execute("DROP TABLE agent_tasks")
            db.execute("PRAGMA user_version=2")
        upgraded = Workspace(self.folder.name)
        with upgraded.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 4)
        backup = next(Path(self.folder.name).glob("workspace.schema2-*.sqlite3"))
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)


@unittest.skipUnless(os.environ.get("VISION_TEST_NATIVE_CORE") == "1", "enable real local task CAD/CAE")
class NativeTaskTest(unittest.TestCase):
    def test_restart_resumes_same_task_and_real_build_study_solve_assessment(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            app = create_app(folder, run_jobs=False)
            with TestClient(app) as client:
                revision = client.post("/api/v2/projects", json=command("project", name="Task beam")).json()
                base = f"/api/v2/projects/{revision['project_id']}"
                plan = [step("build_geometry", script="result=u.create_box((0,0,0),100,20,10)"),
                        step("configure_study", study=STUDY), step("solve"), step("assessment")]
                response = client.post(base + "/tasks", json=command("task", expected_head=revision["revision_id"], statement="按明确工况构建并校核悬臂梁", plan=plan))
                self.assertEqual(response.status_code, 202, response.text)
                task = response.json()["task_id"]
                app.state.tasks.step(task)
                app.state.tasks.step(task)
                self.assertEqual(client.get(f"/api/v2/tasks/{task}").json()["state"], "waiting_job")
            with TestClient(create_app(folder)) as client:
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    result = client.get(f"/api/v2/tasks/{task}").json()
                    if result["state"] in ("completed", "waiting_user"):
                        break
                    time.sleep(.1)
                self.assertEqual(result["state"], "completed", result)
                self.assertEqual(result["turns"], 4)
                self.assertEqual(result["jobs"], 2)
                jobs = client.get(base + "/jobs").json()
                self.assertEqual(len(jobs), 2)
                fea = next(job for job in jobs if job["kind"] == "fea")
                reference = 100 * 100 / (210000 * 200)
                self.assertLess(abs(fea["result"]["summary"]["maxDisplacement"] - reference) / reference, .02)
                self.assertEqual(client.get(base + "/assessments").json()["evidence_job_id"], fea["id"])


if __name__ == "__main__":
    unittest.main()
