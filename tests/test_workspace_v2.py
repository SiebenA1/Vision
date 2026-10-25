"""New-core storage/contracts, plus opt-in real native lifecycle regression."""
import copy
import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if importlib.util.find_spec("fastapi") is None or importlib.util.find_spec("httpx") is None:
    raise unittest.SkipTest("install backend/requirements.txt in the core Python runtime")
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision.jobs import Controller
from backend.vision.storage import Workspace, packed
from backend.vision.processes import ProcessTree


def command(key, head=None, **fields):
    return {"command_id": key, "idempotency_key": key, **({"expected_head": head} if head else {}), **fields}


STUDY = {"material": {"E": 210000, "nu": .3, "rho": 7850, "yieldStrength": 235},
         "supports": [{"id": "fixed", "face": "x-min"}],
         "loads": [{"id": "force", "face": "x-max", "vector": [1, 0, 0], "magnitude": 100}],
         "mesh_size": 4}


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        profile_patch = patch("backend.vision.runtime.profile", return_value={"files": {}, "packages": {"usd-brep": "test-fixture"}})
        profile_patch.start()
        self.addCleanup(profile_patch.stop)
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.created = self.client.post("/api/v2/projects", json=command("create", name="Beam")).json()
        self.project = self.created["project_id"]
        self.head = self.created["revision_id"]
        self.base = f"/api/v2/projects/{self.project}"
        self.store = self.app.state.workspace

    def tearDown(self):
        self.client.close()
        self.folder.cleanup()

    def fake_artifact(self, job, folder):
        with self.store.db() as db:
            row = db.execute("SELECT revision,input FROM jobs WHERE id=?", (job,)).fetchone()
        return self.store.artifacts.publish(folder, ["source.py"], {"kind": "cad", "metrics": {},
            "bodies": [{"id": "body-0", "kind": "solid", "faces": [{"id": "body-0/face-0"}], "edges": []}],
            "provenance": {"revision_id": row["revision"], "input_sha256": hashlib.sha256(row["input"].encode()).hexdigest()}})

    def test_create_is_idempotent_and_rejects_key_reuse(self):
        again = self.client.post("/api/v2/projects", json=command("create", name="Beam"))
        self.assertEqual(again.json(), self.created)
        self.assertEqual(len(self.client.get("/api/v2/projects").json()), 1)
        self.assertEqual(self.client.post("/api/v2/projects", json=command("create", name="Other")).status_code, 409)

    def test_build_preview_is_read_only_and_bound_to_exact_inputs(self):
        request = command("preview", self.head, script="raise RuntimeError('preview must not execute')", parameters={"length": 100})
        preview = self.client.post(self.base + "/build/preview", json=request)
        self.assertEqual(preview.status_code, 200, preview.text)
        impact = preview.json()
        self.assertEqual(impact["script_execution"], "not_executed")
        self.assertEqual(impact["topology"], "unknown_until_native_build")
        self.assertEqual(self.client.get(self.base + "/jobs").json(), [])
        self.assertEqual(len(self.store.history(self.project)), 1)
        changed = {**request, "script": "changed", "expected_impact_digest": impact["digest"]}
        self.assertEqual(self.client.post(self.base + "/build", json=changed).status_code, 409)
        submitted = self.client.post(self.base + "/build", json={**request, "expected_impact_digest": impact["digest"]})
        self.assertEqual(submitted.status_code, 202, submitted.text)
        self.assertEqual(len(self.client.get(self.base + "/jobs").json()), 1)
        revision = self.client.post(self.base + "/rename", json=command("rename", self.head, name="Changed")).json()
        self.assertNotEqual(revision["revision_id"], self.head)
        self.assertEqual(self.client.post(self.base + "/build/preview", json=request).status_code, 409)

    @unittest.skipUnless(os.name == "nt", "Windows aggregate Job Object memory budget")
    def test_process_tree_memory_budget_is_inherited_by_children(self):
        child = "try:\n data=bytearray(256*1024*1024)\n print('UNLIMITED')\nexcept MemoryError:\n print('MEMORY_DENIED')"
        parent = "import subprocess,sys\ninput()\nchild=subprocess.run([sys.executable,'-I','-c'," + repr(child) + "],capture_output=True,text=True)\nprint(child.stdout)\nraise SystemExit(child.returncode)"
        with subprocess.Popen([sys.executable, "-I", "-c", parent], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                              creationflags=subprocess.CREATE_NO_WINDOW) as process:
            tree = ProcessTree(process, memory_limit_mib=128)
            try:
                stdout, stderr = process.communicate("start\n", timeout=15)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertIn("MEMORY_DENIED", stdout)
                self.assertNotIn("UNLIMITED", stdout)
            finally:
                tree.close()

    def test_cas_restore_and_retry_after_head_moves(self):
        request = command("rename", self.head, name="Updated")
        response = self.client.post(self.base + "/rename", json=request)
        self.assertEqual(response.status_code, 200)
        revised = response.json()
        self.assertNotEqual(revised["revision_id"], self.head)
        self.assertEqual(self.client.post(self.base + "/rename", json=request).json(), revised)
        self.assertEqual(self.client.post(self.base + "/rename", json=command("old", self.head, name="Stale")).status_code, 409)
        restored = self.client.post(self.base + "/restore", json=command("restore", revised["revision_id"], revision_id=self.head)).json()
        self.assertEqual(restored["document"]["name"], "Beam")
        self.assertEqual(restored["parent_revision_id"], revised["revision_id"])
        self.assertEqual(len(self.client.get(self.base + "/revisions").json()), 3)

    def test_revision_cannot_be_read_or_restored_from_another_project(self):
        other = self.client.post("/api/v2/projects", json=command("other", name="Other")).json()
        self.assertEqual(self.client.get(self.base + "/revisions/" + other["revision_id"]).status_code, 404)
        self.assertEqual(self.client.post(self.base + "/restore", json=command("restore", self.head, revision_id=other["revision_id"])).status_code, 404)

    def test_strict_contract_rejects_bool_nonfinite_extra_and_invalid_study(self):
        for edit in ({"material": {**STUDY["material"], "E": True}},
                     {"loads": [{"id": "load", "vector": [0, 0, 0], "magnitude": 100}]},
                     {"supports": [{"id": "s", "enabled": False}]},
                     {"body_ids": []}, {"unsupported": "contact"}):
            study = {**copy.deepcopy(STUDY), **edit}
            with self.subTest(edit=edit):
                self.assertEqual(self.client.post(self.base + "/study", json=command("invalid", self.head, study=study)).status_code, 422)
        self.assertEqual(self.store.revision(self.project)["revision_id"], self.head)

    def test_requirement_sources_units_and_unknown_without_evidence(self):
        spec = {"name": "Displacement limit", "metric": "maxDisplacement", "comparison": "le", "threshold": .001, "unit": "mm"}
        request = command("requirement", self.head, statement="Keep displacement below 0.001 mm.", requirement=spec)
        revision = self.client.post(self.base + "/requirements", json=request)
        self.assertEqual(revision.status_code, 200, revision.text)
        requirement = revision.json()["document"]["requirements"][0]
        source = self.client.get(self.base + "/sources/" + requirement["source_event"]).json()
        self.assertEqual(source["payload"]["text"], request["statement"])
        self.assertEqual(self.client.post(self.base + "/requirements", json=request).json(), revision.json())
        findings = self.client.get(self.base + "/assessments").json()["findings"]
        self.assertEqual(findings[0]["status"], "unknown")
        self.assertIsNone(findings[0]["value"])
        invalid = command("invalid-unit", revision.json()["revision_id"], statement="Invalid unit", requirement={**spec, "unit": "MPa"})
        self.assertEqual(self.client.post(self.base + "/requirements", json=invalid).status_code, 422)
        removed = self.client.post(self.base + "/requirements/remove", json=command("remove", revision.json()["revision_id"], requirement_id=requirement["id"]))
        self.assertEqual(removed.json()["document"]["requirements"], [])
        self.assertEqual(self.client.get(self.base + "/sources/" + requirement["source_event"]).status_code, 200)

    def test_study_is_persisted_without_mutating_prior_revision(self):
        response = self.client.post(self.base + "/study", json=command("study", self.head, study=STUDY))
        self.assertEqual(response.status_code, 200, response.text)
        reopened = Workspace(self.folder.name)
        self.assertEqual(reopened.revision(self.project)["document"]["study"]["material"]["E"], 210000)
        self.assertIsNone(reopened.revision(self.project, self.head)["document"]["study"])

    def test_assessment_invalidates_missing_fields_and_failed_latest_attempt(self):
        # Synthetic receipts isolate evaluator failure handling; real numerical accuracy
        # is exercised separately by NativeWorkspaceTest.
        cad_job = self.client.post(self.base + "/build", json=command("cad", self.head, script="fixture")).json()["job_id"]
        self.store.claim()
        folder = Path(self.folder.name) / "fixture"
        folder.mkdir()
        (folder / "source.py").write_text("fixture")
        geometry = self.fake_artifact(cad_job, folder)
        self.store.finish(cad_job, "succeeded", {"artifact_id": geometry["artifactId"]})
        revision = self.store.revision(self.project)
        revision = self.client.post(self.base + "/study", json=command("study", revision["revision_id"], study=STUDY)).json()
        revision = self.client.post(self.base + "/requirements", json=command("requirement", revision["revision_id"], statement="Limit displacement.",
            requirement={"name": "Limit", "metric": "maxDisplacement", "comparison": "le", "threshold": .001, "unit": "mm"})).json()
        job = self.client.post(self.base + "/solve", json=command("solve", revision["revision_id"])).json()["job_id"]
        claimed = self.store.claim()
        (folder / "input.json").write_text(packed(claimed["input"]), encoding="utf-8")
        (folder / "field.npz").write_bytes(b"synthetic test field")
        summary = {"converged": True, "relativeResidual": 1e-10, "equilibriumError": 1e-10,
                   "quality": {"minScaledJacobian": .5, "negativeElements": 0}, "strainEnergyMj": 1.0, "maxDisplacement": .002}
        artifact = self.store.artifacts.publish(folder, ["input.json", "field.npz"], {"kind": "fea", "geometry": geometry["artifactId"], "result": summary,
            "provenance": {"revision_id": revision["revision_id"], "input_sha256": hashlib.sha256(packed(claimed["input"]).encode()).hexdigest()}})
        self.store.finish(job, "succeeded", {"artifact_id": artifact["artifactId"], "summary": summary})
        with patch("backend.vision.assessment.profile", return_value=claimed["input"]["execution"]["profile"]):
            self.assertEqual(self.client.get(self.base + "/assessments").json()["findings"][0]["status"], "fail")
            field = self.store.artifacts.root / artifact["artifactId"] / "field.npz"
            field.unlink()
            self.assertEqual(self.client.get(self.base + "/assessments").json()["findings"][0]["status"], "unknown")
            field.write_bytes(b"synthetic test field")
            retry = self.client.post(self.base + "/solve", json=command("retry", revision["revision_id"])).json()["job_id"]
            self.store.claim()
            self.store.finish(retry, "failed", error="injected native worker failure")
            assessment = self.client.get(self.base + "/assessments").json()
            self.assertEqual(assessment["findings"][0]["status"], "unknown")
            self.assertIsNone(assessment["evidence_job_id"])

    def test_nonfinite_input_returns_json_validation_error(self):
        request = command("invalid", self.head, study=copy.deepcopy(STUDY))
        request["study"]["material"]["E"] = float("nan")
        response = self.client.post(self.base + "/study", content=json.dumps(request), headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["code"], "INVALID_CONTRACT")

    def test_solve_requires_explicit_geometry_and_study(self):
        self.assertEqual(self.client.post(self.base + "/solve", json=command("solve", self.head)).status_code, 422)

    def test_queued_cancel_events_and_recovery(self):
        submitted = self.client.post(self.base + "/build", json=command("build", self.head, script="result=u.create_box((0,0,0),1,1,1)"))
        self.assertEqual(submitted.status_code, 202)
        job = submitted.json()["job_id"]
        self.assertEqual(self.client.post(f"/api/v2/jobs/{job}/cancel").json()["state"], "cancelled")
        self.assertIsNone(self.store.claim())
        states = [item["state"] for item in self.client.get(f"/api/v2/jobs/{job}/events").json()]
        self.assertEqual(states, ["queued", "cancelled"])
        next_job = self.client.post(self.base + "/build", json=command("build2", self.head, script="bad" )).json()["job_id"]
        self.store.claim()
        self.store.recover()
        self.assertEqual(self.store.job(next_job)["state"], "interrupted")
        self.assertEqual(self.client.post(f"/api/v2/jobs/{next_job}/cancel").status_code, 409)

    def test_stale_build_cannot_overwrite_newer_head(self):
        job = self.client.post(self.base + "/build", json=command("build", self.head, script="dummy")).json()["job_id"]
        self.store.claim()
        updated = self.client.post(self.base + "/rename", json=command("rename", self.head, name="Newer")).json()
        folder = Path(self.folder.name) / "fake"
        folder.mkdir()
        (folder / "source.py").write_text("dummy")
        artifact = self.fake_artifact(job, folder)
        self.store.finish(job, "succeeded", {"artifact_id": artifact["artifactId"]})
        self.assertEqual(self.store.revision(self.project)["revision_id"], updated["revision_id"])
        self.assertIsNone(self.store.job(job)["adopted_revision"])
        adopted = self.client.post(self.base + "/adopt", json=command("adopt", updated["revision_id"], job_id=job))
        self.assertEqual(adopted.status_code, 200, adopted.text)
        self.assertEqual(adopted.json()["document"]["geometry"], artifact["artifactId"])
        self.assertEqual(adopted.json()["parent_revision_id"], updated["revision_id"])
        other = self.client.post("/api/v2/projects", json=command("other", name="Other")).json()
        forbidden = self.client.post(f"/api/v2/projects/{other['project_id']}/adopt", json=command("foreign", other["revision_id"], job_id=job))
        self.assertEqual(forbidden.status_code, 404)

    def test_transaction_rolls_back_command_and_revision_together(self):
        def fail(db, doc):
            db.execute("UPDATE projects SET head='broken' WHERE id=?", (self.project,))
            raise RuntimeError("injected failure")
        with self.assertRaises(RuntimeError):
            self.store.edit(self.project, command("fail", self.head), fail)
        self.assertEqual(self.store.revision(self.project)["revision_id"], self.head)
        with self.store.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM receipts WHERE key='fail'").fetchone()[0], 0)

    def test_database_full_at_commit_leaves_no_head_or_receipt_and_retry_works(self):
        import sqlite3
        connect = sqlite3.connect
        class FullConnection(sqlite3.Connection):
            def commit(self):
                error = sqlite3.OperationalError("database or disk is full")
                error.sqlite_errorcode = sqlite3.SQLITE_FULL
                raise error
        request = command("full-db", self.head, name="Retry after space restored")
        with patch("backend.vision.storage.sqlite3.connect", side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=FullConnection)):
            failed = self.client.post(self.base + "/rename", json=request)
            self.assertEqual(failed.status_code, 507, failed.text)
            self.assertEqual(failed.json()["code"], "STORAGE_FULL")
        self.assertEqual(self.store.revision(self.project)["revision_id"], self.head)
        self.assertEqual(len(self.store.history(self.project)), 1)
        with self.store.db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM receipts WHERE key='full-db'").fetchone()[0], 0)
        response = self.client.post(self.base + "/rename", json=request)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.store.history(self.project)), 2)

    def test_artifact_copy_disk_full_never_publishes_partial_directory(self):
        import errno
        import shutil
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            source = Path(folder)
            for name in ("one.bin", "two.bin"):
                (source / name).write_bytes(b"complete")
            copy = shutil.copyfile
            count = 0
            def full_after_first(*args, **kwargs):
                nonlocal count
                count += 1
                if count == 2:
                    raise OSError(errno.ENOSPC, "No space left on device")
                return copy(*args, **kwargs)
            with patch("backend.vision.storage.shutil.copyfile", side_effect=full_after_first):
                with self.assertRaises(OSError):
                    self.store.artifacts.publish(source, ["one.bin", "two.bin"], {"kind": "fixture"})
            self.assertEqual(list(self.store.artifacts.root.iterdir()), [])
            self.assertEqual(self.store.revision(self.project)["revision_id"], self.head)
            artifact = self.store.artifacts.publish(source, ["one.bin", "two.bin"], {"kind": "fixture"})
            self.assertEqual(self.store.artifacts.file(artifact["artifactId"], "two.bin").read_bytes(), b"complete")

    def test_revision_comparison_is_scoped_read_only_and_refuses_different_loads(self):
        from backend.vision.comparisons import compare
        with tempfile.TemporaryDirectory(dir=self.folder.name) as folder:
            source = Path(folder)
            (source / "source.py").write_text("fixture")
            artifact = self.store.artifacts.publish(source, ["source.py"], {"kind": "cad", "settings": {"tolerance_mm": .05, "angle_deg": 10}})
        left = self.store.edit(self.project, command("comparison-study", self.head), lambda db, document: {**document, "geometry": artifact["artifactId"], "study": STUDY})
        right = self.store.edit(self.project, command("comparison-name", left["revision_id"]), lambda db, document: {**document, "name": "Other label"})
        evidence = {"evidence_job_id": "fixture-job", "findings": []}
        summary = {"maxDisplacement": .001, "maxVonMises": 10, "mass_kg": .1, "safetyFactor": 23.5}
        with patch("backend.vision.comparisons.assess", return_value=evidence), patch.object(self.store, "job", return_value={"result": {"summary": summary}}):
            value = compare(self.store, self.project, left["revision_id"], right["revision_id"])
            self.assertTrue(value["comparable"], value)
            self.assertTrue(all(row["difference"] == 0 for row in value["metrics"]))
            self.assertIsNone(value["ranking"])
            changed_study = copy.deepcopy(STUDY)
            changed_study["loads"][0]["magnitude"] *= 2
            changed = self.store.edit(self.project, command("comparison-force", right["revision_id"]), lambda db, document: {**document, "study": changed_study})
            before = len(self.store.history(self.project))
            value = compare(self.store, self.project, left["revision_id"], changed["revision_id"])
            self.assertFalse(value["comparable"])
            self.assertIn("载荷及作用区域不一致", value["reasons"])
            self.assertTrue(all(row["difference"] is None for row in value["metrics"]))
            self.assertEqual(len(self.store.history(self.project)), before)
        other = self.client.post("/api/v2/projects", json=command("foreign-comparison", name="Other")).json()
        response = self.client.get(self.base + "/compare", params={"left": left["revision_id"], "right": other["revision_id"]})
        self.assertEqual(response.status_code, 404)

    def test_failure_between_artifact_publish_and_head_commit_is_recoverable(self):
        job = self.client.post(self.base + "/build", json=command("build", self.head, script="dummy")).json()["job_id"]
        self.store.claim()
        folder = Path(self.folder.name) / "output"
        folder.mkdir()
        (folder / "source.py").write_text("dummy")
        artifact = self.fake_artifact(job, folder)
        with patch.object(self.store, "_commit", side_effect=RuntimeError("injected commit failure")):
            with self.assertRaises(RuntimeError):
                self.store.finish(job, "succeeded", {"artifact_id": artifact["artifactId"]})
        self.assertEqual(self.store.revision(self.project)["revision_id"], self.head)
        self.assertEqual(self.store.job(job)["state"], "running")
        self.store.recover()
        self.assertEqual(self.store.job(job)["state"], "interrupted")
        self.assertEqual(self.store.artifacts.manifest(artifact["artifactId"]), artifact)

    def test_completed_receipt_recovery_verifies_artifact_and_commits_once(self):
        job = self.client.post(self.base + "/build", json=command("recover-build", self.head, script="dummy")).json()["job_id"]
        self.store.claim()
        directory = Path(self.folder.name) / "runs" / job
        directory.mkdir(parents=True)
        (directory / "source.py").write_text("dummy")
        artifact = self.fake_artifact(job, directory)
        (directory / "receipt.json").write_text(packed({"result": {"artifact_id": artifact["artifactId"]}}), encoding="utf-8")
        self.store.recover()
        recovered = self.store.revision(self.project)
        self.assertEqual(self.store.job(job)["state"], "succeeded")
        self.assertEqual(recovered["document"]["geometry"], artifact["artifactId"])
        self.store.recover()
        self.assertEqual(self.store.revision(self.project)["revision_id"], recovered["revision_id"])
        self.assertEqual(len(self.store.history(self.project)), 2)

    def test_execution_budget_is_snapshotted_at_admission(self):
        build = self.client.post(self.base + "/build", json=command("build-budget", self.head, script="dummy")).json()["job_id"]
        self.store.claim()
        folder = Path(self.folder.name) / "budget"
        folder.mkdir()
        (folder / "source.py").write_text("dummy")
        artifact = self.fake_artifact(build, folder)
        self.store.finish(build, "succeeded", {"artifact_id": artifact["artifactId"]})
        current = self.store.revision(self.project)
        configured = self.client.post(self.base + "/study", json=command("study-budget", current["revision_id"], study=STUDY)).json()
        with patch.dict(os.environ, {"VISION_FEA_MAX_ELEMENTS": "1234"}):
            job = self.client.post(self.base + "/solve", json=command("solve-budget", configured["revision_id"])).json()["job_id"]
        with self.store.db() as db:
            inputs = json.loads(db.execute("SELECT input FROM jobs WHERE id=?", (job,)).fetchone()[0])
        self.assertEqual(inputs["execution"]["max_elements"], 1234)
        self.assertIn("usd-brep", inputs["execution"]["profile"]["packages"])

    def test_semantic_binding_does_not_follow_reused_face_numbers(self):
        def build_fake(key, revision):
            job = self.client.post(self.base + "/build", json=command(key, revision, script=key)).json()["job_id"]
            self.store.claim()
            folder = Path(self.folder.name) / key
            folder.mkdir()
            (folder / "source.py").write_text(key)
            artifact = self.fake_artifact(job, folder)
            self.store.finish(job, "succeeded", {"artifact_id": artifact["artifactId"]})
            return self.store.revision(self.project)
        revision = build_fake("first", self.head)
        created = self.client.post(self.base + "/objects", json=command("object", revision["revision_id"], artifact_id=revision["document"]["geometry"], name="Mounting face", purpose="Fix this installation interface", topology_ids=["body-0/face-0"])).json()
        target = created["document"]["objects"][0]
        study = copy.deepcopy(STUDY)
        study["supports"][0]["region"] = {"type": "semantic-object", "object_id": target["id"], "toleranceMm": .1}
        configured = self.client.post(self.base + "/study", json=command("semantic-study", created["revision_id"], study=study)).json()
        preview = self.client.post(self.base + "/build/preview", json=command("preview-impact", configured["revision_id"], script="changed"))
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["objects"][0]["action"], "rebind")
        self.assertEqual(preview.json()["study_regions"][0]["action"], "rebind")
        self.assertEqual(preview.json()["evidence_action"], "recompute")
        newer = build_fake("second", configured["revision_id"])
        self.assertNotEqual(newer["document"]["objects"][0]["binding"]["artifact_id"], newer["document"]["geometry"])
        refused = self.client.post(self.base + "/solve", json=command("stale-binding", newer["revision_id"]))
        self.assertEqual(refused.status_code, 422)
        stale = self.client.post(self.base + "/objects/rebind", json=command("stale-selection", newer["revision_id"], artifact_id=revision["document"]["geometry"], object_id=target["id"], topology_ids=["body-0/face-0"]))
        self.assertEqual(stale.status_code, 422)
        rebound = self.client.post(self.base + "/objects/rebind", json=command("rebind", newer["revision_id"], artifact_id=newer["document"]["geometry"], object_id=target["id"], topology_ids=["body-0/face-0"])).json()
        self.assertEqual(rebound["document"]["objects"][0]["id"], target["id"])
        self.assertEqual(rebound["document"]["objects"][0]["binding"]["artifact_id"], newer["document"]["geometry"])
        self.assertEqual(self.client.post(self.base + "/solve", json=command("bound", rebound["revision_id"])).status_code, 202)

    def test_artifact_integrity_and_file_boundary(self):
        folder = Path(self.folder.name) / "input"
        folder.mkdir()
        (folder / "data.bin").write_bytes(b"original")
        artifacts = self.store.artifacts
        manifest = artifacts.publish(folder, ["data.bin"], {"kind": "test"})
        digest = manifest["artifactId"]
        self.assertEqual(artifacts.publish(folder, ["data.bin"], {"kind": "test"}), manifest)
        self.assertEqual(artifacts.file(digest, "data.bin").read_bytes(), b"original")
        with self.assertRaises(LookupError):
            artifacts.file(digest, "../workspace.sqlite3")
        (artifacts.root / digest / "data.bin").write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            artifacts.file(digest, "data.bin")

    def test_controller_ownership_is_exclusive(self):
        first, second = Controller(self.store), Controller(self.store)
        first.start()
        try:
            with self.assertRaises(RuntimeError):
                second.start()
        finally:
            first.close()

    def test_newer_schema_is_not_overwritten(self):
        with self.store.db() as db:
            db.execute("PRAGMA user_version=7")
        with self.assertRaises(ValueError):
            Workspace(self.folder.name)
        with self.store.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 7)

    def test_schema_upgrade_preserves_a_recoverable_database_backup(self):
        with self.store.db() as db:
            db.execute("PRAGMA user_version=1")
        upgraded = Workspace(self.folder.name)
        backups = list(Path(self.folder.name).glob("workspace.schema1-*.sqlite3"))
        self.assertEqual(len(backups), 1)
        source = sqlite3.connect(backups[0])
        try:
            self.assertEqual(source.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(source.execute("SELECT head FROM projects WHERE id=?", (self.project,)).fetchone()[0], self.head)
        finally:
            source.close()
        self.assertEqual(upgraded.revision(self.project)["revision_id"], self.head)

    def test_foreign_browser_origin_rejected(self):
        self.assertEqual(self.client.post("/api/v2/projects", headers={"Origin": "https://example.com"}, json=command("foreign", name="Invalid")).status_code, 403)

    def test_legacy_preview_is_read_only_and_does_not_execute_script(self):
        response = self.client.post("/api/v2/imports/preview", json={"legacy_model": {
            "schema": "vision.model/1", "id": "legacy", "name": "Imported",
            "revision": "R01", "externalScript": "raise RuntimeError('must not execute')",
            "cad": {"artifactId": "a" * 64}}})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["legacy_artifact_available"])
        self.assertTrue(response.json()["has_saved_script"])
        self.assertEqual(len(self.store.projects()), 1)

    def test_bundle_roundtrip_idempotency_and_nonempty_workspace_protection(self):
        queued = self.client.post(self.base + "/build", json=command("queued", self.head, script="raise RuntimeError('never execute on import')")).json()
        exported = self.client.get(self.base + "/export")
        self.assertEqual(exported.status_code, 200)
        headers = {"X-Command-ID": "recover", "Idempotency-Key": "recover", "Content-Type": "application/zip"}
        refused = self.client.post("/api/v2/imports/bundle", headers=headers, content=exported.content)
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(self.store.job(queued["job_id"])["state"], "queued")
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as target:
            with TestClient(create_app(target, run_jobs=False)) as client:
                restored = client.post("/api/v2/imports/bundle", headers=headers, content=exported.content)
                self.assertEqual(restored.status_code, 201, restored.text)
                self.assertEqual(restored.json()["revision_id"], self.head)
                repeated = client.post("/api/v2/imports/bundle", headers=headers, content=exported.content)
                self.assertEqual(repeated.json(), restored.json())
                self.assertEqual(client.get(f"/api/v2/jobs/{queued['job_id']}").json()["state"], "interrupted")

    def test_invalid_bundle_paths_and_corruption_do_not_create_projects(self):
        exported = self.client.get(self.base + "/export").content
        stream = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(exported)) as original, zipfile.ZipFile(stream, "w") as modified:
            for item in original.infolist():
                modified.writestr(item.filename, original.read(item.filename))
            modified.writestr("../../outside.py", "raise RuntimeError('never execute')")
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as target:
            with TestClient(create_app(target, run_jobs=False)) as client:
                for payload in (b"not a zip", stream.getvalue()):
                    response = client.post("/api/v2/imports/bundle", headers={"X-Command-ID": "invalid", "Idempotency-Key": "invalid"}, content=payload)
                    self.assertEqual(response.status_code, 422, response.text)
                    self.assertEqual(client.get("/api/v2/projects").json(), [])


@unittest.skipUnless(os.environ.get("VISION_TEST_NATIVE_CORE") == "1", "set VISION_TEST_NATIVE_CORE=1 for real CAD/CAE")
class NativeWorkspaceTest(unittest.TestCase):
    def wait(self, client, job, expected="succeeded", timeout=90):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = client.get(f"/api/v2/jobs/{job}").json()
            if result["state"] not in ("queued", "running", "cancelling"):
                self.assertEqual(result["state"], expected, result)
                return result
            time.sleep(.1)
        self.fail(f"job did not finish: {job}")

    @unittest.skipUnless(os.name == "nt", "Windows native memory budget")
    def test_native_memory_failure_preserves_head_and_queue_recovers(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder)) as client:
                revision = client.post("/api/v2/projects", json=command("create", name="Memory failure")).json()
                base = f"/api/v2/projects/{revision['project_id']}"
                with patch.dict(os.environ, {"VISION_WORKER_MEMORY_MIB": "128"}):
                    submitted = client.post(base + "/build", json=command("oversized", revision["revision_id"],
                        script="data=bytearray(512*1024*1024);result=u.create_box((0,0,0),1,1,1)")).json()
                inputs = client.get(f"/api/v2/jobs/{submitted['job_id']}/input").json()
                self.assertEqual(inputs["execution"]["memory_limit_mib"], 128)
                failed = self.wait(client, submitted["job_id"], "failed")
                self.assertIn("MemoryError", failed["error"])
                self.assertEqual(client.get(base).json()["revision_id"], revision["revision_id"])
                retry = client.post(base + "/build", json=command("small", revision["revision_id"], script="result=u.create_box((0,0,0),1,1,1)")).json()
                self.wait(client, retry["job_id"])

    def test_native_selection_is_trimmed_ambiguous_and_independent_of_long_jobs(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            app = create_app(folder)
            with TestClient(app) as client:
                revision = client.post("/api/v2/projects", json=command("create", name="Selection plate")).json()
                base = f"/api/v2/projects/{revision['project_id']}"
                script = "result=u.boolean_difference(u.create_box((0,0,0),20,20,10),u.create_cylinder((10,10,-1),2,12))"
                job = client.post(base + "/build", json=command("build", revision["revision_id"], script=script)).json()
                self.wait(client, job["job_id"])
                revision = client.get(base).json()
                query = {"revision_id": revision["revision_id"], "artifact_id": revision["document"]["geometry"]}
                def pick(kind, point):
                    return client.post(base + "/inspect", json={**query, "pick": {"kind": kind, "point": point, "tolerance_mm": .01}})
                face = pick("face", [3, 3, 10])
                self.assertEqual(face.status_code, 200, face.text)
                selected = face.json()
                self.assertEqual(selected["candidate_count"], 1)
                self.assertAlmostEqual(selected["metrics"][0]["area_mm2"], 400 - 4 * 3.141592653589793, delta=.01)
                self.assertTrue(selected["visual"]["lines"])
                self.assertEqual(pick("face", [10, 10, 10]).json()["candidate_count"], 0, "hole must not become a selected infinite plane")
                corner = pick("face", [0, 0, 10]).json()
                self.assertGreater(corner["candidate_count"], 1)
                self.assertEqual(corner["selection"], [], "ambiguous picks must not select the first face")
                edge = pick("edge", [10, 0, 10]).json()
                self.assertEqual(edge["candidate_count"], 1)
                self.assertAlmostEqual(edge["metrics"][0]["length_mm"], 20)
                self.assertEqual(pick("body", [3, 3, 10]).json()["selection"], ["body-0"])
                invalid = client.post(base + "/inspect", json={**query, "selection": ["body-0/face-9999"]})
                self.assertEqual(invalid.status_code, 422)
                other = client.post("/api/v2/projects", json=command("other", name="Other")).json()
                self.assertEqual(client.post(f"/api/v2/projects/{other['project_id']}/inspect", json=query).status_code, 404)
                self.assertEqual(client.post(base + "/inspect", json={**query, "artifact_id": "a" * 64}).status_code, 422)
                # Resource contention is explicit; it never consumes the CAD/FEA queue.
                app.state.queries.slot.acquire()
                try:
                    self.assertEqual(pick("face", [3, 3, 10]).status_code, 503)
                finally:
                    app.state.queries.slot.release()
                app.state.queries.timeout = .0001
                self.assertEqual(pick("face", [3, 3, 10]).status_code, 504)
                self.assertIsNone(app.state.queries.active)
                self.assertEqual(list(Path(folder).glob("query-*")), [])
                app.state.queries.timeout = 15
                slow = client.post(base + "/build", json=command("slow", revision["revision_id"], script="import time; time.sleep(30)")).json()
                deadline = time.monotonic() + 10
                while client.get(f"/api/v2/jobs/{slow['job_id']}").json()["state"] != "running" and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertEqual(pick("face", [3, 3, 10]).status_code, 200)
                self.assertEqual(client.get(f"/api/v2/jobs/{slow['job_id']}").json()["state"], "running")
                client.post(f"/api/v2/jobs/{slow['job_id']}/cancel")
                self.wait(client, slow["job_id"], "cancelled")
                self.assertEqual(client.get(base).json()["revision_id"], revision["revision_id"])

    def test_semantic_binding_requires_reconfirmation_after_parameter_edit(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder)) as client:
                revision = client.post("/api/v2/projects", json=command("create", name="Bound beam")).json()
                base = f"/api/v2/projects/{revision['project_id']}"
                script = "result=u.create_box((0,0,0),parameters['length'],20,10)"
                def build(key, length):
                    current = client.get(base).json()
                    request = command(key, current["revision_id"], script=script, parameters={"length": length}, use_current=False)
                    preview = client.post(base + "/build/preview", json=request)
                    self.assertEqual(preview.status_code, 200, preview.text)
                    queued = client.post(base + "/build", json={**request, "expected_impact_digest": preview.json()["digest"]})
                    self.assertEqual(queued.status_code, 202, queued.text)
                    result = self.wait(client, queued.json()["job_id"])
                    manifest = client.get(f"/api/v2/artifacts/{result['result']['artifact_id']}/manifest").json()
                    face = min(manifest["bodies"][0]["faces"], key=lambda item: item["bbox_mm"]["max"][0])["id"]
                    return client.get(base).json(), face
                revision, face = build("initial", 100)
                response = client.post(base + "/objects", json=command("object", revision["revision_id"],
                    artifact_id=revision["document"]["geometry"], name="Mounting face", purpose="Clamp the left end of the beam.", topology_ids=[face]))
                self.assertEqual(response.status_code, 200, response.text)
                revision = response.json()
                target = revision["document"]["objects"][0]
                study = copy.deepcopy(STUDY)
                study["supports"][0]["region"] = {"type": "semantic-object", "object_id": target["id"], "toleranceMm": .1}
                study["body_ids"] = ["body-0"]
                unscoped = client.post(base + "/study", json=command("unscoped-bodies", revision["revision_id"], study=study))
                self.assertEqual(unscoped.status_code, 422)
                study["body_artifact_id"] = revision["document"]["geometry"]
                revision = client.post(base + "/study", json=command("study", revision["revision_id"], study=study)).json()
                self.assertEqual(revision["document"]["study"]["body_artifact_id"], revision["document"]["geometry"])
                job = client.post(base + "/solve", json=command("solve", revision["revision_id"])).json()
                baseline = self.wait(client, job["job_id"])["result"]["summary"]["maxDisplacement"]
                revision, face = build("longer", 120)
                rejected = client.post(base + "/solve", json=command("stale-binding", revision["revision_id"]))
                self.assertEqual(rejected.status_code, 422, rejected.text)
                self.assertIn("review", rejected.text)
                response = client.post(base + "/objects/rebind", json=command("rebind", revision["revision_id"],
                    artifact_id=revision["document"]["geometry"], object_id=target["id"], topology_ids=[face]))
                self.assertEqual(response.status_code, 200, response.text)
                revision = response.json()
                self.assertEqual(revision["document"]["objects"][0]["id"], target["id"])
                still_stale = client.post(base + "/solve", json=command("stale-bodies", revision["revision_id"]))
                self.assertEqual(still_stale.status_code, 422)
                old_selection = client.post(base + "/study", json=command("old-bodies", revision["revision_id"], study=revision["document"]["study"]))
                self.assertEqual(old_selection.status_code, 422)
                confirmed = {**revision["document"]["study"], "body_artifact_id": revision["document"]["geometry"]}
                revision = client.post(base + "/study", json=command("current-bodies", revision["revision_id"], study=confirmed)).json()
                job = client.post(base + "/solve", json=command("solve-longer", revision["revision_id"])).json()
                displacement = self.wait(client, job["job_id"])["result"]["summary"]["maxDisplacement"]
                self.assertAlmostEqual(displacement / baseline, 1.2, delta=.02)

    def test_real_build_solve_reopen_failure_and_cancellation(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder)) as client:
                created = client.post("/api/v2/projects", json=command("create", name="Native beam")).json()
                base = f"/api/v2/projects/{created['project_id']}"
                built = client.post(base + "/build", json=command("build", created["revision_id"], script="result=u.create_box((0,0,0),100,20,10)" )).json()
                cad = self.wait(client, built["job_id"])
                head = client.get(base).json()
                self.assertEqual(head["document"]["geometry"], cad["result"]["artifact_id"])
                study = client.post(base + "/study", json=command("study", head["revision_id"], study=STUDY)).json()
                submitted = client.post(base + "/solve", json=command("solve", study["revision_id"])).json()
                solved = self.wait(client, submitted["job_id"])
                import struct
                import numpy as np
                field_id = solved["result"]["artifact_id"]
                display = client.get(f"/api/v2/artifacts/{field_id}/manifest").json()["display"]
                self.assertEqual(display["method"], "indexed-fem-boundary")
                binary = client.get(f"/api/v2/artifacts/{field_id}/files/surface.bin").content
                magic, node_count, triangle_count = struct.unpack_from("<8sII", binary)
                self.assertEqual(magic, b"VSURF001")
                self.assertEqual(len(binary), 16 + 28 * node_count + 12 * triangle_count)
                archive = client.get(f"/api/v2/artifacts/{field_id}/files/field.npz").content
                with np.load(io.BytesIO(archive), allow_pickle=False) as saved:
                    nodes, indices = np.unique(saved["surfaceTriangles"], return_inverse=True)
                    actual_positions = np.frombuffer(binary, dtype="<f4", count=3*node_count, offset=16).reshape(-1, 3)
                    np.testing.assert_array_equal(actual_positions, saved["positions"].reshape(-1, 3)[nodes])
                    np.testing.assert_array_equal(np.frombuffer(binary, dtype="<u4", offset=16 + 28*node_count), indices)
                result = solved["result"]["summary"]
                self.assertLess(abs(result["maxDisplacement"] - 100*100/(210000*200)) / (100*100/(210000*200)), .02)
                self.assertLess(result["relativeResidual"], 1e-6)
                self.assertLess(result["equilibriumError"], 1e-6)
                added = client.post(base + "/requirements", json=command("limit", study["revision_id"], statement="Displacement must not exceed 0.001 mm.",
                    requirement={"name": "Displacement limit", "metric": "maxDisplacement", "comparison": "le", "threshold": .001, "unit": "mm"}))
                self.assertEqual(added.status_code, 200, added.text)
                study = added.json()
                assessment = client.get(base + "/assessments").json()
                self.assertEqual(assessment["evidence_job_id"], submitted["job_id"])
                self.assertEqual(assessment["findings"][0]["status"], "pass")
                artifact = solved["result"]["artifact_id"]
                self.assertEqual(client.get(f"/api/v2/artifacts/{artifact}/files/field.npz").status_code, 200)
                manifest = client.get(f"/api/v2/artifacts/{cad['result']['artifact_id']}/manifest").json()
                faces = manifest["bodies"][0]["faces"]
                left = min(faces, key=lambda face: face["bbox_mm"]["max"][0])["id"]
                right = max(faces, key=lambda face: face["bbox_mm"]["min"][0])["id"]
                native_study = copy.deepcopy(STUDY)
                for item, face in ((native_study["supports"][0], left), (native_study["loads"][0], right)):
                    item["region"] = {"type": "cad-face", "artifactId": cad["result"]["artifact_id"], "faceIds": [face], "toleranceMm": .1}
                native_revision = client.post(base + "/study", json=command("native-study", study["revision_id"], study=native_study)).json()
                native_job = client.post(base + "/solve", json=command("native-solve", native_revision["revision_id"])).json()
                native_result = self.wait(client, native_job["job_id"])
                self.assertAlmostEqual(native_result["result"]["summary"]["maxDisplacement"], result["maxDisplacement"], places=10)
                # Legacy import copies verified BRep bytes; it does not run the old script.
                legacy_model = {"schema": "vision.model/1", "id": "legacy-model", "name": "Legacy beam",
                    "cad": {"artifactId": cad["result"]["artifact_id"]},
                    "externalScript": "raise RuntimeError('legacy script must not run')",
                    "meta": {"designIntent": "Preserve the original user description"}}
                with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as target:
                    with patch("backend.vision.migrations.LEGACY_ROOT", Path(folder) / "artifacts"):
                        with TestClient(create_app(target)) as migrated:
                            preview = migrated.post("/api/v2/imports/preview", json={"legacy_model": legacy_model}).json()
                            self.assertTrue(preview["legacy_artifact_available"])
                            request = command("legacy", legacy_model=legacy_model, study=native_study)
                            imported = migrated.post("/api/v2/imports/legacy", json=request)
                            self.assertEqual(imported.status_code, 201, imported.text)
                            migrated_revision = imported.json()
                            new_geometry = migrated_revision["document"]["geometry"]
                            self.assertNotEqual(new_geometry, cad["result"]["artifact_id"])
                            self.assertEqual(migrated_revision["document"]["study"]["supports"][0]["region"]["artifactId"], new_geometry)
                            source = migrated_revision["document"]["legacy_source"]
                            self.assertEqual(migrated.get(f"/api/v2/artifacts/{source}/files/model.json").json(), legacy_model)
                            self.assertEqual(migrated.post("/api/v2/imports/legacy", json=request).json(), migrated_revision)
                            migrated_base = f"/api/v2/projects/{migrated_revision['project_id']}"
                            replay = migrated.post(migrated_base + "/build", json=command("no-replay", migrated_revision["revision_id"], script=legacy_model["externalScript"], use_current=False, replay_of=new_geometry))
                            self.assertEqual(replay.status_code, 422)
                            migrated_job = migrated.post(migrated_base + "/solve", json=command("migrated-solve", migrated_revision["revision_id"])).json()
                            migrated_result = self.wait(migrated, migrated_job["job_id"])
                            self.assertAlmostEqual(migrated_result["result"]["summary"]["maxDisplacement"], result["maxDisplacement"], places=10)
                # Restore the saved baseline through a new revision, then test failures against it.
                study = client.post(base + "/restore", json=command("restore-baseline", native_revision["revision_id"], revision_id=study["revision_id"])).json()
                failed = client.post(base + "/build", json=command("fail", study["revision_id"], script="raise RuntimeError('intentional failure')")).json()
                self.wait(client, failed["job_id"], "failed")
                self.assertEqual(client.get(base).json()["revision_id"], study["revision_id"])
                child_file = Path(folder) / "child.pid"
                script = "import subprocess, sys, time\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nPath(" + repr(str(child_file)) + ").write_text(str(child.pid))\ntime.sleep(30)\nresult=u.create_box((0,0,0),1,1,1)"
                slow = client.post(base + "/build", json=command("slow", study["revision_id"], script=script)).json()
                deadline = time.monotonic() + 10
                while not child_file.exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertTrue(child_file.exists(), "native child did not start")
                child_pid = int(child_file.read_text())
                client.post(f"/api/v2/jobs/{slow['job_id']}/cancel")
                self.wait(client, slow["job_id"], "cancelled", timeout=10)
                if os.name == "nt":
                    import ctypes as c
                    from ctypes import wintypes as w
                    kernel = c.WinDLL("kernel32", use_last_error=True)
                    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
                    kernel.OpenProcess.restype = w.HANDLE
                    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
                    kernel.CloseHandle.argtypes = [w.HANDLE]
                    handle = kernel.OpenProcess(0x1000, False, child_pid)
                    if handle:
                        try:
                            code = w.DWORD()
                            self.assertTrue(kernel.GetExitCodeProcess(handle, c.byref(code)))
                            self.assertNotEqual(code.value, 259, "cancel left a running descendant")
                        finally:
                            kernel.CloseHandle(handle)
            with TestClient(create_app(folder)) as reopened:
                self.assertEqual(reopened.get(base).json()["revision_id"], study["revision_id"])
                self.assertEqual(reopened.get(f"/api/v2/jobs/{submitted['job_id']}").json()["result"]["artifact_id"], artifact)
                self.assertEqual(reopened.get(f"/api/v2/artifacts/{artifact}/files/field.npz").status_code, 200)
                exported = reopened.get(base + "/export")
                self.assertEqual(exported.status_code, 200, exported.text[:200] if exported.status_code != 200 else '')
                with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as target:
                    with TestClient(create_app(target)) as recovered:
                        imported = recovered.post("/api/v2/imports/bundle", headers={"X-Command-ID": "recover", "Idempotency-Key": "recover"}, content=exported.content)
                        self.assertEqual(imported.status_code, 201, imported.text)
                        self.assertEqual(imported.json()["revision_id"], study["revision_id"])
                        restored_job = recovered.get(f"/api/v2/jobs/{submitted['job_id']}").json()
                        self.assertEqual(restored_job["result"]["origin"], "imported")
                        restored_assessment = recovered.get(base + "/assessments").json()
                        self.assertEqual(restored_assessment["findings"][0]["status"], "unknown")
                        restored_field = recovered.get(f"/api/v2/artifacts/{artifact}/files/field.npz")
                        self.assertEqual(restored_field.content, reopened.get(f"/api/v2/artifacts/{artifact}/files/field.npz").content)
                tampered = io.BytesIO()
                with zipfile.ZipFile(io.BytesIO(exported.content)) as original, zipfile.ZipFile(tampered, "w") as modified:
                    for item in original.infolist():
                        payload = b"corrupt" if item.filename.endswith("/field.npz") else original.read(item.filename)
                        modified.writestr(item.filename, payload)
                with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as target:
                    with TestClient(create_app(target, run_jobs=False)) as rejected:
                        response = rejected.post("/api/v2/imports/bundle", headers={"X-Command-ID": "tampered", "Idempotency-Key": "tampered"}, content=tampered.getvalue())
                        self.assertEqual(response.status_code, 422)
                        self.assertEqual(rejected.get("/api/v2/projects").json(), [])

    def test_native_timeout_leaves_head_unchanged(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder, cad_timeout=2)) as client:
                created = client.post("/api/v2/projects", json=command("create", name="Timeout")).json()
                base = f"/api/v2/projects/{created['project_id']}"
                job = client.post(base + "/build", json=command("timeout", created["revision_id"], script="import time; time.sleep(30)")).json()
                self.wait(client, job["job_id"], "timed_out", timeout=15)
                self.assertEqual(client.get(base).json()["revision_id"], created["revision_id"])

    def test_replay_uses_original_inputs_instead_of_reapplying_transform(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder)) as client:
                revision = client.post("/api/v2/projects", json=command("create", name="Replay")).json()
                base = f"/api/v2/projects/{revision['project_id']}"
                script = "result=u.create_box((0,0,0),20,10,10)"
                for index in range(4):
                    request = command(f"build-{index}", revision["revision_id"], script=script)
                    if index > 1:
                        request.update(use_current=False, replay_of=revision["document"]["geometry"])
                    job = client.post(base + "/build", json=request).json()
                    result = self.wait(client, job["job_id"])
                    revision = client.get(base).json()
                    manifest = client.get(f"/api/v2/artifacts/{result['result']['artifact_id']}/manifest").json()
                    if index:
                        self.assertAlmostEqual(manifest["bodies"][0]["bbox_mm"]["min"][0], 10, delta=.001)
                    inputs = client.get(f"/api/v2/artifacts/{result['result']['artifact_id']}/files/input.json").content
                    self.assertEqual(hashlib.sha256(inputs).hexdigest(), manifest["provenance"]["input_sha256"])
                    script = "result=u.translate(parts['body_1'].copy(),(10,0,0))"


if __name__ == "__main__":
    unittest.main()
