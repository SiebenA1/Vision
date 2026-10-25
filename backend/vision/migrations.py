"""Explicit read-only legacy extraction; no script replay or guessed history."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

from .contracts import Study
from .storage import identity, packed
from .validation import validate_cad

LEGACY_ROOT = Path(__file__).resolve().parents[2] / "server/.cad_artifacts"


def legacy_geometry(model):
    cad = model.get("cad")
    digest = cad.get("artifactId") if isinstance(cad, dict) else None
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("legacy model has no native artifact identity")
    directory = LEGACY_ROOT / digest
    if not (directory / "manifest.json").is_file():
        raise ValueError("legacy native artifact is missing; no script was executed")
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    validate_cad(manifest)
    bodies = manifest.get("bodies")
    if not isinstance(bodies, list) or not bodies:
        raise ValueError("legacy body manifest is invalid")
    files = ["model.usda", "preview.stl"]
    native_hash = hashlib.sha256()
    total = 0
    for index, body in enumerate(bodies):
        if body.get("id") != f"body-{index}" or body.get("stlFile") != f"body-{index}.stl":
            raise ValueError("legacy body ordering is invalid")
        files.extend([f"body-{index}.brep", f"body-{index}.stl"])
    for name in files:
        path = directory / name
        if not path.is_file():
            raise ValueError(f"legacy native file missing: {name}")
        total += path.stat().st_size
        if total > 128 * 1024 * 1024:
            raise ValueError("legacy geometry exceeds the 128 MiB prototype limit")
    for index in range(len(bodies)):
        native_hash.update((directory / f"body-{index}.brep").read_bytes())
    if native_hash.hexdigest() != manifest.get("nativeSha256"):
        raise ValueError("legacy BRep checksum does not match its manifest")
    return digest, directory, manifest, files


def import_legacy(workspace, request):
    model = request["legacy_model"]
    if model.get("schema") != "vision.model/1" or not isinstance(model.get("id"), str) or not isinstance(model.get("name"), str):
        raise ValueError("expected a legacy vision.model/1 document")
    old_id, source, manifest, files = legacy_geometry(model)
    source_text = packed(model)
    original_study = request.get("study")
    receipt = {key: request[key] for key in ("command_id", "idempotency_key")}
    receipt.update(operation="import_legacy", legacy_sha256=hashlib.sha256(source_text.encode()).hexdigest(), study=original_study)
    with tempfile.TemporaryDirectory(prefix="legacy-", dir=workspace.root) as temporary:
        directory = Path(temporary)
        (directory / "model.json").write_text(source_text, encoding="utf-8")
        legacy_source = workspace.artifacts.publish(directory, ["model.json"], {"kind": "legacy-source", "schema": "vision.legacy/1"})
        for name in files:
            shutil.copyfile(source / name, directory / name)
        (directory / "source.py").write_text(str(model.get("externalScript", "")), encoding="utf-8")
        (directory / "input.json").write_text(packed({"legacy_model_id": model["id"], "legacy_artifact_id": old_id}), encoding="utf-8")
        geometry = workspace.artifacts.publish(directory, [*files, "source.py", "input.json"],
            {**{key: value for key, value in manifest.items() if key not in ("artifactId", "files", "provenance")},
             "kind": "cad", "replay_available": False,
             "provenance": {"origin": "legacy-import", "legacy_artifact_id": old_id, "legacy_source": legacy_source["artifactId"],
                            "notice": "Original build lineage is not reconstructed from a final BRep or display revision label."}})
    study = json.loads(packed(original_study)) if original_study else None
    if study:
        if study.get("body_ids"):
            known_bodies = {body["id"] for body in manifest["bodies"] if body["kind"] == "solid"}
            if study.get("body_artifact_id") not in (None, old_id) or not set(study["body_ids"]) <= known_bodies:
                raise ValueError("legacy study already contains stale analysis body selection")
            study["body_artifact_id"] = geometry["artifactId"]
        known_faces = {face["id"] for body in manifest["bodies"] for face in body["faces"]}
        for item in study["supports"] + study["loads"]:
            region = item.get("region")
            if region and region["type"] == "cad-face":
                if region["artifactId"] != old_id or not set(region["faceIds"]) <= known_faces:
                    raise ValueError("legacy study already contains stale face bindings")
                # Exact same native BRep bytes and ordering; no geometric guessing.
                region["artifactId"] = geometry["artifactId"]
        Study.model_validate(study)
    def create(db):
        project = identity()
        db.execute("INSERT INTO projects VALUES(?,?)", (project, "pending"))
        return workspace._commit(db, project, None, {"schema_version": "vision.project/2", "name": model["name"],
            "geometry": geometry["artifactId"], "study": study, "legacy_source": legacy_source["artifactId"]})
    return workspace.command("workspace", receipt, create)
