"""Deterministic build-impact preview. It never evaluates Python or predicts topology."""
import hashlib

from .storage import Conflict, packed
from .contracts import Build


def build_impact(workspace, document, request):
    # Receipts round-trip through JSON before execution. Normalize numeric
    # fields again so equivalent values such as 10 and 10.0 hash identically.
    request = Build.model_validate(request).model_dump()
    geometry = document.get("geometry")
    source = geometry if request["use_current"] else None
    parameters = request["parameters"]
    if request.get("replay_of"):
        if request["replay_of"] != geometry:
            raise ValueError("replay must reference the current geometry artifact")
        original = workspace.artifacts.manifest(geometry)
        if original.get("replay_available") is False:
            raise ValueError("legacy build lineage is unavailable; choose an explicit fresh or incremental build")
        source = original["provenance"].get("resolved_source")
        parameters = {**original["parameters"], **parameters}
    if source:
        workspace.artifacts.manifest(source)
    study = document.get("study")
    regions = []
    if study:
        for category in ("supports", "loads"):
            for item in study[category]:
                if not item.get("enabled", True):
                    continue
                kind = (item.get("region") or {}).get("type", "bbox-extreme")
                regions.append({"id": item["id"], "name": item.get("name", item["id"]), "category": category,
                    "region_type": kind, "action": "rebind" if kind in ("cad-face", "semantic-object") else "review_region"})
    command = {key: request[key] for key in ("script", "parameters", "tolerance_mm", "angle_deg", "use_current", "replay_of", 'module_assembly')}
    result = {"schema": "vision.build-impact/1", "base_revision_id": request["expected_head"],
        "geometry": geometry, "source_artifact": source, "parameters_before_script": parameters,
        "command_sha256": hashlib.sha256(packed(command).encode()).hexdigest(),
        "document_sha256": hashlib.sha256(packed(document).encode()).hexdigest(),
        "objects": [{"id": item["id"], "name": item["name"],
            "action": "rebind" if item["binding"]["artifact_id"] == geometry else "already_stale"} for item in document.get("objects", [])],
        "study_regions": regions, "selected_bodies_to_review": study.get("body_ids") or [] if study else [],
        "evidence_action": "recompute" if geometry and study else "no_current_analysis",
        "requirement_count": len(document.get("requirements", [])),
        "topology": "unknown_until_native_build", "script_execution": "not_executed",
        "notice": "预检只列出已知依赖。自由 Python 脚本的实际输出、拓扑变化和运行副作用不能由此预先证明。"}
    result["digest"] = hashlib.sha256(packed(result).encode()).hexdigest()
    return result


def preview_build(workspace, project, request):
    revision = workspace.revision(project)
    if revision["revision_id"] != request["expected_head"]:
        raise Conflict("project changed; reload before previewing the build")
    if request.get('module_assembly'):
        from .code_modules import resolve
        script,modules = resolve(workspace,project,revision['document'],request['module_assembly'],request.get('use_current',True))
        if request.get('script') and request['script'] != script:
            raise Conflict('module program does not match the current exact module plan')
        request={**request,'script':script}
    return build_impact(workspace, revision["document"], request)
