"""Deterministic requirements evaluation against current, local numerical evidence."""
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path

from .runtime import profile
from .storage import packed
from .studies import native_study


def calculation_key(document, runtime):
    if not document.get("geometry") or not document.get("study"):
        return None
    study = native_study(document)
    physical = {"material": study["material"], "mesh_size": study["mesh_size"],
                "body_ids": sorted(study["body_ids"]) if study.get("body_ids") else None}
    for name in ("supports", "loads"):
        physical[name] = []
        for item in study[name]:
            if not item.get("enabled", True):
                continue
            fields = ("face", "region", "type") if name == "supports" else ("face", "region", "vector", "magnitude")
            physical[name].append({key: item[key] for key in fields if key in item})
    return hashlib.sha256(packed({"geometry": document["geometry"], "study": physical, "runtime": runtime}).encode()).hexdigest()


def assess(workspace, project, revision_id=None):
    with workspace.db() as db:
        revision = workspace._revision(db, project, revision_id)
        jobs = [dict(row) for row in db.execute("SELECT * FROM jobs WHERE project=? AND kind='fea' ORDER BY created DESC,rowid DESC", (project,))]
        ids = [item["source_event"] for item in revision["document"].get("requirements", [])]
        sources = {row["id"]: json.loads(row["payload"]) for row in db.execute(
            f"SELECT id,payload FROM sources WHERE project=? AND id IN ({','.join('?' for _ in ids)})", (project, *ids))} if ids else {}
    document = revision["document"]
    candidate, values, reason = None, None, "当前输入尚无成功的数值证据"
    try:
        current_key = calculation_key(document, profile("fea")) if document.get("geometry") and document.get("study") else None
    except ValueError as failure:
        current_key = None
        reason = f"当前输入尚不能核验：{failure}"
    except importlib.metadata.PackageNotFoundError:
        current_key = None
        reason = "当前数值运行环境不可用，无法核验历史证据"
    for job in jobs:
        inputs = json.loads(job["input"])
        try:
            previous_key = calculation_key(inputs["document"], inputs.get("execution", {}).get("profile"))
        except ValueError:
            continue
        if current_key is None or previous_key != current_key:
            continue
        candidate = job
        if job["state"] != "succeeded":
            reason = "相同输入的最近一次计算尚未成功"
            break
        result = json.loads(job["result"])
        if result.get("origin") == "imported":
            reason = "导入结果尚未在当前环境复算"
            break
        try:
            manifest = workspace.artifacts.manifest(result["artifact_id"])
            provenance = manifest["provenance"]
            if manifest["kind"] != "fea" or manifest["geometry"] != document["geometry"] or provenance["input_sha256"] != hashlib.sha256(job["input"].encode()).hexdigest():
                raise ValueError("evidence provenance mismatch")
            for filename in ("input.json", "field.npz"):
                workspace.artifacts.file(result["artifact_id"], filename)
            summary = manifest["result"]
            if summary.get("converged") is not True:
                raise ValueError("solver did not converge")
            for key in ("relativeResidual", "equilibriumError"):
                if not isinstance(summary.get(key), (float, int)) or not math.isfinite(summary[key]) or not 0 <= summary[key] <= 1e-6:
                    raise ValueError("numerical checks did not pass")
            quality = summary.get("quality") or {}
            jacobian = quality.get("minScaledJacobian")
            if quality.get("negativeElements") != 0 or type(jacobian) not in (float, int) or not math.isfinite(jacobian) or jacobian <= 0:
                raise ValueError("mesh validity evidence is missing or invalid")
            energy = summary.get("strainEnergyMj")
            if type(energy) not in (float, int) or not math.isfinite(energy) or energy <= 0:
                raise ValueError("positive finite strain energy was not established")
            values = summary
        except (ValueError, KeyError, OSError, LookupError) as failure:
            reason = f"数值证据未通过核验：{failure}"
        break
    findings = []
    for requirement in document.get("requirements", []):
        value = values.get(requirement["metric"]) if values else None
        valid = type(value) in (float, int) and math.isfinite(value) and value >= 0
        source = sources.get(requirement["source_event"])
        source_valid = source and isinstance(source.get("text"), str) and bool(source["text"].strip())
        status = "unknown"
        if valid and source_valid:
            passed = value <= requirement["threshold"] if requirement["comparison"] == "le" else value >= requirement["threshold"]
            status = "pass" if passed else "fail"
        findings.append({"requirement": requirement, "status": status, "value": value if valid else None,
                         "source_origin": source.get("origin") if source else None,
                         "reason": "要求来源不可核验" if not source_valid else "在当前线弹性模型及已定义指标下比较" if valid else reason})
    return {"revision_id": revision["revision_id"], "calculation_key": current_key,
            "evidence_job_id": candidate["id"] if candidate and values else None, "findings": findings,
            "method": "linear-static-threshold/1", "evaluator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "scope": "isotropic-linear-static", "notice": "指标满足不代表整体工程适用性或应力收敛已获证明。"}
