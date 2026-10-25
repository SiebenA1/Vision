"""Opt-in live DeepSeek replay on synthetic projects, never existing workspaces."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from backend.vision.api import create_app
from backend.vision.provider import status
from backend.vision.runtime import profile


def command(key, **fields):
    return {"command_id": key, "idempotency_key": key, **fields}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="send synthetic task data to the official DeepSeek endpoint")
    parser.add_argument("--case", choices=("clarify", "axial", "natural-axial", "invalid-study", "correction", "wheel-bolt"), required=True)
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required; this script makes real provider calls")
    config = status()
    if not config["configured"]:
        raise SystemExit("Backend key not configured; no remote request sent")
    statement = ("请对工程做静力分析。我尚未提供几何、材料、约束和载荷。请用 ask_user 问清必要输入，禁止猜测或创建几何及求解。" if args.case in ("clarify", "correction") else
        "在这个全新测试工程中完成真实建模和轴向线弹性校核。先查询 native_api 获取 create_box 签名，再创建原点(0,0,0)的长方体，x长100mm、y宽20mm、z高10mm。"
        "明确工况：E=210000MPa，nu=0.3，rho=7850kg/m3，yieldStrength=235MPa；x-min固定，x-max施加总合力100N，vector=[1,0,0]；mesh_size=4mm。"
        "按 build_geometry、configure_study、solve、assessment、finish 逐步执行，每步先看工具回执。支持和载荷使用 face='x-min'/'x-max' 选择器，id分别fixed/load。"
        "无需 body_ids 或工程要求。不要编造求解结果，失败则说明原因；finish 用简短中文说明及局限。")
    if args.case == "natural-axial":
        statement = "请建立一根从原点开始、沿X长100mm、Y宽20mm、Z高10mm的实心直梁并校核静力响应。材料E=210000MPa、泊松比0.3、密度7850kg/m³、屈服强度235MPa。X最小端面固定，X最大端面施加沿+X方向的100N总合力，网格尺寸4mm。请根据真实计算说明位移和适用范围。"
    if args.case == "invalid-study":
        statement = "我想分析直梁，材料弹性模量填写为-210000MPa。请先检查这个材料输入是否有效，在我澄清之前不要创建几何或提交求解。"
    if args.case == "wheel-bolt":
        statement = "根据汽车轮毂螺栓的常见几何形态，帮我建模一个出来。尺寸参数由你自行选择，作为概念示意，不宣称已经验证具体车型或行业标准；螺纹允许明确标注为光杆简化。需要六角头、螺栓杆和轮毂座面。已授权你自行确定方案，无需再次确认，直接完成实际建模，暂时不做仿真分析。"
    started = time.monotonic()
    report = {"time": datetime.now(timezone.utc).isoformat(), "case": args.case, "provider": config,
              "repetitions": 1, "execution_profile": profile("fea") if args.case in ("axial", "natural-axial") else None}
    with tempfile.TemporaryDirectory(prefix="vision-live-model-") as folder:
        with TestClient(create_app(folder)) as client:
            project = client.post("/api/v2/projects", json=command("project", name="Synthetic live replay")).json()
            result = client.post(f"/api/v2/projects/{project['project_id']}/model-tasks", json=command("model", expected_head=project["revision_id"], statement=statement, **({"unlimited":True} if args.case == "wheel-bolt" else {})))
            if result.status_code != 202:
                raise SystemExit("Task creation failed: " + result.text)
            task = result.json()["task_id"]
            until = time.monotonic() + 300
            while time.monotonic() < until:
                value = client.get(f"/api/v2/tasks/{task}").json()
                if args.case == "correction" and value["state"] == "waiting_user" and value["epoch"] == 1 and value["steps"][-1]["response"]["tool"] == "ask_user":
                    head = client.get(f"/api/v2/projects/{project['project_id']}").json()
                    corrected = client.post(f"/api/v2/tasks/{task}/correct-model", json=command("correction", expected_head=head["revision_id"], expected_epoch=1,
                        statement="更正：现在不创建几何、不配置工况、不运行求解。只查询当前工程可核验的数值证据，说明缺少什么，然后结束任务。"))
                    if corrected.status_code != 200:
                        raise SystemExit("Correction failed: " + corrected.text)
                    continue
                if value["state"] in ("completed", "waiting_user", "cancelled"):
                    break
                time.sleep(.2)
            else:
                client.post(f"/api/v2/tasks/{task}/cancel", json=command("timeout", expected_epoch=value["epoch"]))
            report.update(state=value["state"], error=value["error"], requests=value["turns"], native_jobs=value["jobs"],
                epoch=value["epoch"], reported_tokens_all_epochs=sum((step["response"].get("provider", {}).get("usage", {}).get("total_tokens", 0)) for step in value["steps"] if step["response"]),
                used_tokens=value["config"]["used_tokens"], steps=[{"tool": step["response"]["tool"], "state": step["state"],
                    "provider": step["response"].get("provider"), "error": step["error"]} for step in value["steps"]])
            jobs = client.get(f"/api/v2/projects/{project['project_id']}/jobs").json()
            report["generated_scripts"] = [(client.get(f"/api/v2/jobs/{job['id']}/input").json()["command"]["script"]) for job in jobs if job["kind"] == "cad"]
            if args.case == "wheel-bolt":
                _, raw = client.app.state.tasks.snapshot(task)
                report['api_lookups'] = [dict(arguments=json.loads(step['response'])['arguments'], receipt=json.loads(step['receipt']))
                    for step in raw if step['state']=='succeeded' and json.loads(step['response']).get('tool')=='native_api']
            if args.case in ("clarify", "invalid-study"):
                report["passed"] = value["state"] == "waiting_user" and value["jobs"] == 0 and value["steps"][-1]["response"]["tool"] == "ask_user"
            elif args.case == "correction":
                current = [step for step in value["steps"] if step["epoch"] == 2]
                report["within_request_target"] = value["turns"] <= 4
                report["passed"] = value["epoch"] == 2 and value["state"] == "completed" and value["jobs"] == 0 and any(step["response"]["tool"] == "assessment" for step in current) and report["within_request_target"]
            elif args.case == "wheel-bolt":
                cad = next((job for job in jobs if job['kind']=='cad' and job['state']=='succeeded'), None)
                first_build = next((index+1 for index, step in enumerate(value['steps']) if step['response'] and step['response']['tool']=='build_geometry'), None)
                report.update(first_build_request=first_build, cad_artifact=cad['result']['artifact_id'] if cad else None)
                report['passed'] = bool(value['state']=='completed' and cad and first_build and first_build <= 8 and not any(job['kind']=='fea' for job in jobs))
            else:
                jobs = client.get(f"/api/v2/projects/{project['project_id']}/jobs").json()
                fea = next((job for job in jobs if job["kind"] == "fea" and job["state"] == "succeeded"), None)
                assessment = client.get(f"/api/v2/projects/{project['project_id']}/assessments").json()
                reference = 100 * 100 / (210000 * 200)
                actual = fea["result"]["summary"]["maxDisplacement"] if fea else None
                report.update(displacement_mm=actual, reference_mm=reference, relative_error=abs(actual-reference)/reference if actual is not None else None)
                report["passed"] = bool(value["state"] == "completed" and fea and assessment["evidence_job_id"] == fea["id"] and report["relative_error"] < .02)
    output = Path("screenshots") / f"deepseek-{args.case}-{int(time.time())}.json"
    report["elapsed_seconds"] = round(time.monotonic() - started, 3)
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("Replay record:", output.resolve())
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
