"""Resolve declared engineering objects to artifact-scoped native face regions."""
import copy


def configure_study(workspace, document, study):
    configured = copy.deepcopy(study)
    if configured.get("body_ids"):
        if not document["geometry"] or configured.get("body_artifact_id") != document["geometry"]:
            raise ValueError("analysis body selection must explicitly reference the current geometry; select again")
        manifest = workspace.artifacts.manifest(document["geometry"])
        solids = {item["id"] for item in manifest["bodies"] if item["kind"] == "solid"}
        if not set(configured["body_ids"]) <= solids:
            raise ValueError("select current closed solids for analysis")
    return configured


def native_study(document):
    if not document.get("study"):
        return None
    study = copy.deepcopy(document["study"])
    if study.get("body_ids") and study.get("body_artifact_id") != document["geometry"]:
        raise ValueError("analysis body selection needs review against the current geometry")
    objects = {item["id"]: item for item in document.get("objects", [])}
    for item in study["supports"] + study["loads"]:
        if not item.get("enabled", True):
            continue
        region = item.get("region")
        if not region or region["type"] != "semantic-object":
            continue
        target = objects.get(region["object_id"])
        if not target or target["binding"]["artifact_id"] != document["geometry"]:
            raise ValueError("engineering object needs rebinding to the current geometry")
        faces = target["binding"]["topology_ids"]
        if not all("/face-" in identity for identity in faces):
            raise ValueError("analysis regions require objects explicitly bound to native faces")
        item["region"] = {"type": "cad-face", "artifactId": document["geometry"],
                          "faceIds": faces, "toleranceMm": region["toleranceMm"]}
    return study


def validate_binding(workspace, document, topology_ids, artifact_id):
    if not document.get("geometry"):
        raise ValueError("build native geometry before binding an object")
    if artifact_id != document["geometry"]:
        raise ValueError("selected topology belongs to an older geometry; select again")
    manifest = workspace.artifacts.manifest(document["geometry"])
    known = set()
    for body in manifest["bodies"]:
        known.add(body["id"])
        known.update(face["id"] for face in body["faces"])
        known.update(edge["id"] for edge in body.get("edges", []))
    if len(set(topology_ids)) != len(topology_ids) or not set(topology_ids) <= known:
        raise ValueError("binding contains duplicate or unavailable native topology")
    return {"artifact_id": document["geometry"], "topology_ids": topology_ids}
