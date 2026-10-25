"""Provider protocol faults plus real native tools; remote calls are opt-in."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if importlib.util.find_spec("fastapi") is None:
    raise unittest.SkipTest("install backend/requirements.txt")
import httpx
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision import provider
from test_tasks_v2 import command, STUDY, ProcessCrash


def response(tool="assessment", arguments=None, call="call_1"):
    if tool == 'finish':
        arguments = {'outcome':'answer', **(arguments or {})}
    return {"id": "response_" + call, "model": "deepseek-flash", "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        "choices": [{"finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
            "tool_calls": [{"id": call, "type": "function", "function": {"name": tool, "arguments": json.dumps(arguments or {})}}]}}]}


class ModelTaskTest(unittest.TestCase):
    def test_geometry_tools_are_offered_only_after_a_successful_build(self):
        compiled = {"revision_id": "test", "project": {"geometry": None}, "recent_tool_groups": []}
        names = lambda: {item["function"]["name"] for item in provider.payload(compiled, "deepseek-flash")["tools"]}
        required = {"list_topology", "inspect_geometry", "read_script", "solve"}
        self.assertFalse(names() & required)
        self.assertTrue({"native_api", "ask_user", "finish"} <= names())
        self.assertNotIn("build_geometry", names())
        compiled['cad_api_signatures'] = [{'symbol': 'usd_brep.create_box', 'signature': 'create_box(origin, length, width, height)'}]
        self.assertNotIn('build_geometry', names())
        self.assertIn('set_modeling_requirements', names())
        compiled['project']['modeling_requirements'] = [{'name':'fixture','metric':'solid_count','minimum':1,'source_ids':['fixture']}]
        self.assertIn('build_geometry', names())
        compiled["project"]["geometry"] = "a" * 64
        self.assertTrue(required <= names())
        compiled["project"]["geometry"] = None
        self.assertFalse(names() & required)

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.app = create_app(self.folder.name, run_jobs=False)
        self.client = TestClient(self.app)
        self.tasks = self.app.state.tasks
        self.key = patch("backend.vision.provider.api_key", return_value="test-only-key")
        self.key.start()
        project = self.client.post("/api/v2/projects", json=command("project", name="Model protocol")).json()
        self.project, self.head = project["project_id"], project["revision_id"]

    def tearDown(self):
        self.key.stop()
        self.client.close()
        self.folder.cleanup()

    def create(self, **fields):
        result = self.client.post(f"/api/v2/projects/{self.project}/model-tasks", json=command("model-task",
            expected_head=self.head, statement="只查询当前证据，不要猜测工况", unlimited=False, **fields))
        self.assertEqual(result.status_code, 202, result.text)
        task = result.json()["task_id"]
        self.tasks.step(task)
        return task

    def test_response_then_tool_receipt_then_next_request_and_finish(self):
        task = self.create()
        with patch("backend.vision.provider.complete", side_effect=[response(), response("finish", {"summary": "缺少数值证据，尚不能核验"}, "call_2")]) as complete:
            self.tasks.step(task)
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value["state"], "completed")
        self.assertEqual(value["config"]["used_tokens"], 30)
        self.assertEqual(value["steps"][0]["response"]["provider"]["call_id"], "call_1")
        sent = json.loads(complete.call_args.args[0]["messages"][1]["content"])
        self.assertEqual(sent["recent_tool_groups"][0]["instruction"]["tool"], "assessment")
        self.assertNotIn("assessment", [tool["function"]["name"] for tool in complete.call_args.args[0]["tools"]])
        sent["recent_tool_groups"].append({"revision_id": sent["revision_id"], "instruction": {"tool": "solve"}, "tool_receipt": {}})
        self.assertIn("assessment", [tool["function"]["name"] for tool in provider.payload(sent, "deepseek-flash")["tools"]])
        self.assertNotIn("test-only-key", json.dumps(sent))

    def test_interrupted_request_is_not_reissued(self):
        task = self.create()
        with patch("backend.vision.provider.complete", side_effect=ProcessCrash()) as complete:
            with self.assertRaises(ProcessCrash):
                self.tasks.step(task)
            self.tasks.step(task)
            self.assertEqual(complete.call_count, 1)
        self.assertEqual(self.tasks.get(task)["state"], "waiting_user")
        self.assertIn("outcome unknown", self.tasks.get(task)["error"])

    def test_truncated_reply_is_corrected_once_and_usage_is_counted(self):
        task = self.create()
        truncated = response()
        truncated['choices'][0]['finish_reason'] = 'length'
        with patch('backend.vision.provider.complete', side_effect=[truncated, response('finish', {'summary': '已纠正'}, 'call-repaired')]):
            self.tasks.step(task)
            self.assertEqual(self.tasks.get(task)['state'], 'executing')
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'completed')
        self.assertEqual(value['config']['used_tokens'], 30)
        self.assertEqual(value['steps'][0]['state'], 'rejected')
        self.assertEqual(value['steps'][0]['response']['provider']['finish_reason'], 'length')

    def test_correction_discards_late_response_and_runs_new_epoch(self):
        task = self.create()
        def corrected(request):
            result = self.client.post(f"/api/v2/tasks/{task}/correct-model", json=command("correct", expected_head=self.head,
                expected_epoch=1, statement="新轮次只检查证据"))
            self.assertEqual(result.status_code, 200, result.text)
            return response()
        with patch("backend.vision.provider.complete", side_effect=corrected):
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value["epoch"], 2)
        self.assertEqual(value["state"], "created")
        self.assertEqual(value["steps"][0]["state"], "superseded")

    def test_invalid_duplicate_and_truncated_responses_never_execute_tools(self):
        cases = [response("not_a_tool"), response("solve", {"expected_head": self.head}), response(), response("inspect_geometry"),
            response("configure_study", {"study": {**STUDY, "body_artifact_id": "a" * 64}})]
        cases[2]["choices"][0]["finish_reason"] = "length"
        for index, bad in enumerate(cases):
            with self.subTest(index=index):
                task = self.tasks.create(self.project, command(f"bad-{index}", expected_head=self.head,
                    statement="Protocol validation", max_jobs=1, max_requests=2), model=True)["task_id"]
                self.tasks.step(task)
                with patch("backend.vision.provider.complete", return_value=bad), patch("backend.vision.tasks.execute") as execute:
                    self.tasks.step(task)
                    if self.tasks.get(task)["state"] == "executing":
                        repeated = json.loads(json.dumps(bad))
                        repeated["choices"][0]["message"]["tool_calls"][0]["id"] = "call_second_invalid"
                        with patch("backend.vision.provider.complete", return_value=repeated):
                            self.tasks.step(task)
                execute.assert_not_called()
                self.assertEqual(self.tasks.get(task)["state"], "waiting_user")
        task = self.create()
        with patch("backend.vision.provider.complete", return_value=response()):
            self.tasks.step(task)
            self.tasks.step(task)
        self.assertIn("duplicate", self.tasks.get(task)["error"])

    def test_extra_api_query_field_is_returned_to_model_and_repaired(self):
        task = self.create()
        bad = response("native_api", {"suggest_query": "boolean"})
        with patch("backend.vision.provider.complete", return_value=bad), patch("backend.vision.tasks.execute") as execute:
            self.tasks.step(task)
            execute.assert_not_called()
        rejected = self.tasks.get(task)
        self.assertEqual(rejected["state"], "executing")
        self.assertEqual(rejected["steps"][0]["state"], "rejected")
        self.assertIn("suggest_query", rejected["steps"][0]["error"])
        self.assertNotIn("input_value", rejected["steps"][0]["error"])
        with patch("backend.vision.provider.complete", return_value=response("native_api", {"query": "boolean"}, "call_fixed")) as complete, \
             patch("backend.vision.tasks.execute", return_value={"entries": []}) as execute:
            self.tasks.step(task)
        self.assertEqual(execute.call_args.args[3], "native_api")
        self.assertEqual(execute.call_args.args[4]["query"], "boolean")
        compiled = json.loads(complete.call_args.args[0]["messages"][1]["content"])
        self.assertFalse(compiled["last_tool_rejection"]["tools_executed"])
        self.assertIn("suggest_query", compiled["last_tool_rejection"]["reason"])
        self.assertEqual(self.tasks.get(task)["config"]["used_tokens"], 30)

        another = self.tasks.create(self.project, command("bad-schema-twice", expected_head=self.head,
            statement="查询 CAD 接口", max_jobs=1,max_requests=3), model=True)["task_id"]
        self.tasks.step(another)
        with patch("backend.vision.provider.complete", side_effect=[bad, response("native_api", {"suggest_query":"boolean"}, "call_bad_again")]), \
             patch("backend.vision.tasks.execute") as execute:
            self.tasks.step(another)
            self.tasks.step(another)
            execute.assert_not_called()
        self.assertEqual(self.tasks.get(another)["state"], "waiting_user")
        self.assertIn("自动纠正仍未通过", self.tasks.get(another)["error"])

    def test_multiple_calls_repair_once_without_executing_rejected_calls(self):
        multiple = response()
        multiple["choices"][0]["message"]["tool_calls"].append(response("solve")["choices"][0]["message"]["tool_calls"][0])
        for outcome in (response("finish", {"summary": "没有执行被拒绝的调用"}, "call_2"), multiple):
            task = self.tasks.create(self.project, command("repair-" + str(id(outcome)), expected_head=self.head,
                statement="查询证据", max_jobs=1, max_requests=3), model=True)["task_id"]
            self.tasks.step(task)
            with patch("backend.vision.provider.complete", return_value=multiple), patch("backend.vision.tasks.execute") as execute:
                self.tasks.step(task)
                execute.assert_not_called()
            value = self.tasks.get(task)
            self.assertEqual(value["state"], "executing")
            self.assertEqual(value["steps"][0]["state"], "rejected")
            self.assertEqual(value["config"]["used_tokens"], 15)
            with patch("backend.vision.provider.complete", return_value=outcome) as complete:
                self.tasks.step(task)
            self.assertIn("NONE were executed", complete.call_args.args[0]["messages"][0]["content"])
            value = self.tasks.get(task)
            self.assertEqual(value["state"], "completed" if outcome is not multiple else "waiting_user")
            self.assertEqual(value["jobs"], 0)
            self.assertEqual(value["turns"], 2)
            self.assertEqual(value["config"]["used_tokens"], 30)
            with patch("backend.vision.provider.complete") as complete:
                self.tasks.step(task)
                complete.assert_not_called()

        task = self.create(max_requests=1)
        with patch("backend.vision.provider.complete", return_value=multiple) as complete:
            self.tasks.step(task)
            self.tasks.step(task)
            self.assertEqual(complete.call_count, 1)
        self.assertEqual(self.tasks.get(task)["state"], "waiting_user")
        self.assertIn("budget", self.tasks.get(task)["error"])

    def test_call_id_is_an_opaque_bounded_identifier(self):
        self.assertEqual(provider.parse(response(call="functions.assessment:0"), "deepseek-flash")[1]["call_id"], "functions.assessment:0")
        for call in ("", "bad\nid", "a" * 201):
            invalid = response(call=call)
            invalid["id"] = "response_test"
            with self.assertRaisesRegex(ValueError, "valid function call id"):
                provider.parse(invalid, "deepseek-flash")

    def test_request_budget_and_import_do_not_automatically_resume(self):
        task = self.create(max_requests=1)
        with patch("backend.vision.provider.complete", return_value=response()) as complete:
            self.tasks.step(task)
            self.tasks.step(task)
            self.assertEqual(complete.call_count, 1)
        self.assertIn("budget", self.tasks.get(task)["error"])
        data = self.client.get(f"/api/v2/projects/{self.project}/export").content
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder:
            with TestClient(create_app(folder, run_jobs=False)) as client:
                restored = client.post("/api/v2/imports/bundle", headers={"X-Command-ID": "restore", "Idempotency-Key": "restore"}, content=data)
                self.assertEqual(restored.status_code, 201, restored.text)
                self.assertEqual(client.get(f"/api/v2/tasks/{task}").json()["state"], "waiting_user")

    def test_transport_endpoint_no_redirects_redacted_errors_and_bounded_json(self):
        actual = httpx.AsyncClient
        for status, content in [(200, json.dumps(response()).encode()), (401, b'test-only-key secret payload'), (302, b''), (200, b'not json'), (200, b'x' * 262145)]:
            with self.subTest(status=status, size=len(content)):
                def handle(request):
                    self.assertEqual(str(request.url), provider.URL)
                    self.assertEqual(request.headers["authorization"], "Bearer test-only-key")
                    return httpx.Response(status, content=content)
                def client(**kwargs):
                    self.assertFalse(kwargs["follow_redirects"])
                    self.assertFalse(kwargs["trust_env"])
                    return actual(transport=httpx.MockTransport(handle), **kwargs)
                with patch("backend.vision.provider.httpx.AsyncClient", side_effect=client):
                    if status == 200 and len(content) < 262144 and content.startswith(b'{'):
                        self.assertEqual(provider.complete({})["id"], "response_call_1")
                    else:
                        with self.assertRaises(ValueError) as caught:
                            provider.complete({})
                        self.assertNotIn("test-only-key", str(caught.exception))

    def test_missing_key_and_model_context_source_deletion(self):
        with patch("backend.vision.provider.api_key", return_value=""), patch("backend.vision.provider.complete") as complete:
            result = self.client.post(f"/api/v2/projects/{self.project}/model-tasks", json=command("missing-key",
                expected_head=self.head, statement="Check evidence"))
            self.assertEqual(result.status_code, 422, result.text)
            complete.assert_not_called()
        local = self.client.post(f"/api/v2/projects/{self.project}/tasks", json=command("source-task", expected_head=self.head,
            statement="当前证据必须保留引用的私有来源", plan=[{"tool": "assessment", "arguments": {}}])).json()["task_id"]
        source = self.tasks.get(local)["source"]
        task = self.create()
        def forget_during_request(request):
            self.tasks.forget(self.project, command("forget", source_id=source))
            return response()
        with patch("backend.vision.provider.complete", side_effect=forget_during_request):
            self.tasks.step(task)
        value = self.tasks.get(task)
        self.assertEqual(value["state"], "cancelled")
        self.assertEqual(value["config"]["mode"], "redacted")
        self.assertIsNone(value["steps"][0]["response"])


@unittest.skipUnless(os.environ.get("VISION_TEST_NATIVE_CORE") == "1", "enable native model-tool protocol test")
class NativeModelTaskTest(unittest.TestCase):
    def test_model_receipts_drive_real_cad_and_fea_without_remote_provider(self):
        sequence = [response("native_api", {"query": "create_box"}, "call_1"),
            response("build_geometry", {"script": "result=u.create_box((0,0,0),100,20,10)"}, "call_2"),
            response("list_topology", {"query": "face"}, "call_3"),
            response("configure_study", {"study": STUDY}, "call_4"), response("solve", {}, "call_5"),
            response("assessment", {}, "call_6"), response("finish", {"summary": "已完成工具核验，范围为线弹性静力"}, "call_7")]
        replies = iter(sequence)
        def model_reply(request):
            compiled = json.loads(request['messages'][1]['content'])
            if not compiled['project'].get('modeling_requirements'):
                return response('set_modeling_requirements', {'requirements':[{'name':'100mm轴向梁', 'metric':'bbox_x_mm',
                    'minimum':99.99, 'maximum':100.01, 'source_ids':[compiled['statement_source_id']]}]}, 'goal')
            return next(replies)
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as folder, patch("backend.vision.provider.api_key", return_value="test-only-key"), patch("backend.vision.provider.complete", side_effect=model_reply):
            with TestClient(create_app(folder)) as client:
                project = client.post("/api/v2/projects", json=command("project", name="Native protocol")).json()
                result = client.post(f"/api/v2/projects/{project['project_id']}/model-tasks", json=command("model", expected_head=project["revision_id"], statement="按明确工况核验轴向梁"))
                self.assertEqual(result.status_code, 202, result.text)
                task = result.json()["task_id"]
                until = time.monotonic() + 90
                while time.monotonic() < until:
                    value = client.get(f"/api/v2/tasks/{task}").json()
                    if value["state"] in ("completed", "waiting_user"):
                        break
                    time.sleep(.1)
                self.assertEqual(value["state"], "completed", value)
                self.assertEqual(value["jobs"], 2)
                self.assertEqual(len(value["steps"]), 8)
                topology = value["steps"][3]["receipt"]
                self.assertEqual(topology["total_matches"], 6)
                self.assertTrue(all("/face-" in item["id"] and "bbox_mm" in item for item in topology["entries"]))
                jobs = client.get(f"/api/v2/projects/{project['project_id']}/jobs").json()
                fea = next(job for job in jobs if job["kind"] == "fea")
                self.assertEqual(value["steps"][6]["receipt"]["evidence_job_id"], fea["id"])
                reference = 100 * 100 / (210000 * 200)
                self.assertLess(abs(fea["result"]["summary"]["maxDisplacement"] - reference) / reference, .02)
