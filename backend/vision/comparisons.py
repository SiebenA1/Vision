"""Conservative read-only comparison of immutable revisions in one project."""
import math

from .assessment import assess
from .studies import native_study
from .storage import packed

METRICS = {"maxDisplacement": "mm", "maxVonMises": "MPa", "mass_kg": "kg", "safetyFactor": "1"}


def comparison_inputs(workspace, document):
    native_study(document)  # Reject stale semantic bindings/body scope first.
    study = document.get("study")
    if not study or not document.get("geometry"):
        raise ValueError("缺少几何或明确工况")
    result = {"material": study["material"], "mesh_size": study["mesh_size"], "body_ids": study.get("body_ids"),
        "requirements": sorted([{key: item[key] for key in ("name", "metric", "comparison", "threshold", "unit")}
                                for item in document.get("requirements", [])], key=packed)}
    for name in ("supports", "loads"):
        result[name] = []
        for item in study[name]:
            if not item.get("enabled", True):
                continue
            region = item.get("region")
            entry = {"region": region} if region else {"face": item["face"]}
            if region and region["type"] == "semantic-object":
                target = next(obj for obj in document["objects"] if obj["id"] == region["object_id"])
                entry["purpose"] = target["purpose"]
            entry.update({"vector": item["vector"], "magnitude": item["magnitude"]} if name == "loads" else {"type": item.get("type", "fixed")})
            result[name].append(entry)
        result[name].sort(key=packed)
    result["cad_discretization"] = workspace.artifacts.manifest(document["geometry"])["settings"]
    return result


def compare(workspace, project, left, right):
    revisions = [workspace.revision(project, identity) for identity in (left, right)]
    reasons, inputs = [], []
    for revision in revisions:
        try:
            inputs.append(comparison_inputs(workspace, revision["document"]))
        except (ValueError, KeyError, StopIteration) as error:
            inputs.append(None)
            reasons.append(f"版本 {revision['revision_id'][:12]} 无法比较：{error}")
    if all(value is not None for value in inputs):
        for key, label in (("material", "材料"), ("mesh_size", "请求网格尺寸"), ("body_ids", "分析体选择"),
            ("requirements", "工程指标"), ("supports", "约束及作用区域"), ("loads", "载荷及作用区域"), ("cad_discretization", "CAD 离散设置")):
            if packed(inputs[0][key]) != packed(inputs[1][key]):
                reasons.append(f"{label}不一致")
        if any(value["body_ids"] for value in inputs) and revisions[0]["document"]["geometry"] != revisions[1]["document"]["geometry"]:
            reasons.append("不同几何的显式分析体编号不能自动视为相同工程对象")
    sides = []
    for revision in revisions:
        assessment = assess(workspace, project, revision["revision_id"])
        evidence = workspace.job(assessment["evidence_job_id"]) if assessment["evidence_job_id"] else None
        if not evidence:
            reasons.append(f"版本 {revision['revision_id'][:12]} 缺少当前环境下可核验的成功证据")
        if any(finding["status"] == "unknown" for finding in assessment["findings"]):
            reasons.append(f"版本 {revision['revision_id'][:12]} 存在来源或数值尚不能核验的工程指标")
        sides.append({"revision_id": revision["revision_id"], "geometry": revision["document"]["geometry"],
            "assessment": assessment, "evidence_job_id": assessment["evidence_job_id"],
            "summary": evidence["result"]["summary"] if evidence else None})
    metrics = []
    for key, unit in METRICS.items():
        values = [(side["summary"] or {}).get(key) for side in sides]
        values = [value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None for value in values]
        valid = all(value is not None for value in values)
        metrics.append({"metric": key, "unit": unit, "left": values[0], "right": values[1],
            "difference": values[1] - values[0] if valid and not reasons else None,
            "relative_difference": (values[1] - values[0]) / values[0] if valid and not reasons and values[0] else None})
    return {"schema": "vision.comparison/1", "left": sides[0], "right": sides[1], "comparable": not reasons,
        "reasons": reasons, "metrics": metrics, "ranking": None,
        "notice": "比较固定版本的数值摘要；相同网格策略不代表网格相同或应力已收敛。未定义的指标不自动补齐，不自动判定最佳方案。"}
