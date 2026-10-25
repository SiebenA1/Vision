"""Versioned, checksummed project recovery bundles. Import never executes code."""
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sqlite3
import tempfile
import time
import zipfile

from .contracts import Document, TaskStep
from .storage import Conflict, Missing, packed
from .validation import validate_cad

MAX_BUNDLE = 32 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
TABLES = {
    "projects": ("id", "head"),
    "revisions": ("id", "project", "parent", "document", "created"),
    "jobs": ("id", "project", "revision", "kind", "input", "state", "result", "error", "adopted_revision", "created", "updated"),
    "receipts": ("scope", "key", "command_id", "request", "response"),
    "sources": ("id", "project", "payload", "created"),
    "agent_tasks": ("id", "project", "revision", "epoch", "state", "source", "config", "summary", "error", "turns", "jobs", "created", "updated"),
    "agent_turns": ("id", "task", "epoch", "ordinal", "revision", "state", "response", "arguments", "receipt", "job", "error", "created"),
}


def export_project(workspace, project):
    # Snapshot metadata first; immutable artifacts remain referenced for this export.
    with tempfile.TemporaryDirectory(prefix="export-", dir=workspace.root) as temporary:
        snapshot = Path(temporary) / "snapshot.sqlite3"
        source, target = sqlite3.connect(workspace.path), sqlite3.connect(snapshot)
        try:
            source.backup(target)
        finally:
            source.close()
            target.close()
        db = sqlite3.connect(snapshot)
        db.row_factory = sqlite3.Row
        try:
            rows = db.execute("SELECT * FROM projects WHERE id=?", (project,)).fetchall()
            if not rows:
                raise Missing("project unavailable")
            data = {"schema": "vision.bundle/4", "projects": [dict(row) for row in rows]}
            for table in ("revisions", "jobs", "receipts", "sources", "agent_tasks"):
                column = "scope" if table == "receipts" else "project"
                data[table] = [dict(row) for row in db.execute(f"SELECT * FROM {table} WHERE {column}=?", (project,))]
            data["agent_turns"] = [dict(row) for row in db.execute("SELECT t.* FROM agent_turns t JOIN agent_tasks a ON a.id=t.task WHERE a.project=?", (project,))]
            task_ids, source_ids = {row["id"] for row in data["agent_tasks"]}, {row["id"] for row in data["sources"]}
            for row in db.execute("SELECT * FROM receipts WHERE scope='workspace'"):
                response = json.loads(row["response"])
                if response.get("task_id") in task_ids or (response.get("forgotten_source_ids") and set(response["forgotten_source_ids"]) <= source_ids):
                    data["receipts"].append(dict(row))
        finally:
            db.close()
    artifacts = {json.loads(row["document"])["geometry"] for row in data["revisions"]}
    artifacts.update(json.loads(row["result"])["artifact_id"] for row in data["jobs"] if row["result"])
    artifacts.discard(None)
    artifacts.update(json.loads(row['payload'])['code_revision'] for row in data['sources']
                     if json.loads(row['payload']).get('origin')=='code_module' or json.loads(row['payload']).get('original_origin')=='code_module')
    artifacts.update(json.loads(row["document"]).get("legacy_source") for row in data["revisions"])
    artifacts.discard(None)
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as bundle:
        metadata = packed(data)
        bundle.writestr("project.json", metadata)
        pending, included, expanded = list(artifacts), set(), len(metadata.encode())
        while pending:
            digest = pending.pop()
            if digest in included:
                continue
            included.add(digest)
            manifest = workspace.artifacts.manifest(digest)
            pending.extend(item['code_revision'] for item in manifest.get('module_execution',{}).get('components',[]))
            resolved_source = manifest.get("provenance", {}).get("resolved_source")
            if resolved_source:
                pending.append(resolved_source)
            legacy_source = manifest.get("provenance", {}).get("legacy_source")
            if legacy_source:
                pending.append(legacy_source)
            manifest_text = packed(manifest)
            expanded += len(manifest_text.encode())
            bundle.writestr(f"artifacts/{digest}/manifest.json", manifest_text)
            for name in manifest["files"]:
                path = workspace.artifacts.file(digest, name)
                expanded += path.stat().st_size
                if expanded > MAX_EXPANDED:
                    raise ValueError("bundle exceeds the 128 MiB expanded prototype limit")
                bundle.write(path, f"artifacts/{digest}/{name}")
            if "input.json" in manifest["files"]:
                inputs = json.loads(workspace.artifacts.file(digest, "input.json").read_text(encoding="utf-8"))
                source = inputs.get("document", {}).get("geometry")
                if source:
                    pending.append(source)
                replay = inputs.get("command", {}).get("replay_of")
                if replay:
                    pending.append(replay)
    if result.tell() > MAX_BUNDLE:
        raise ValueError("bundle exceeds the 32 MiB prototype limit")
    return result.getvalue()


def import_project(workspace, content, command):
    try:
        return _import_project(workspace, content, command)
    except (zipfile.BadZipFile, KeyError, TypeError, sqlite3.IntegrityError) as error:
        raise ValueError(f"invalid bundle data: {error}") from error


def _import_project(workspace, content, command):
    if len(content) > MAX_BUNDLE:
        raise ValueError("bundle exceeds 32 MiB")
    request = {**command, "bundle_sha256": hashlib.sha256(content).hexdigest(), "operation": "import_bundle"}
    with zipfile.ZipFile(io.BytesIO(content)) as bundle:
        infos = bundle.infolist()
        names = {item.filename for item in infos}
        if len(names) != len(infos) or sum(item.file_size for item in infos) > MAX_EXPANDED:
            raise ValueError("duplicate entries or oversized bundle")
        if "project.json" not in names:
            raise ValueError("project manifest missing")
        data = json.loads(bundle.read("project.json"))
        if data.get("schema") not in ("vision.bundle/2", "vision.bundle/3", "vision.bundle/4") or len(data.get("projects", [])) != 1:
            raise ValueError("unsupported project bundle")
        data.setdefault("sources", [])  # v2 bundles created before requirements were introduced.
        if data["schema"] == "vision.bundle/2":
            data.setdefault("agent_tasks", [])
            data.setdefault("agent_turns", [])
        # All inserts target known columns; metadata cannot provide SQL identifiers.
        for table, columns in TABLES.items():
            if not isinstance(data.get(table), list):
                raise ValueError("invalid bundle table")
            if any(not isinstance(row, dict) or set(row) != set(columns) for row in data[table]):
                raise ValueError(f"invalid {table} record")
            for row in data[table]:
                for key in ("created", "updated"):
                    if key in row and (type(row[key]) not in (float, int) or not math.isfinite(row[key]) or row[key] < 0):
                        raise ValueError("invalid record timestamp")
        project = data["projects"][0]
        project_id = project["id"]
        if not isinstance(project_id, str) or not re.fullmatch(r"[a-f0-9]{32}", project_id):
            raise ValueError("invalid project identity")
        revision_ids = {row["id"] for row in data["revisions"]}
        if len(revision_ids) != len(data["revisions"]) or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value) for value in revision_ids):
            raise ValueError("invalid revision identities")
        if project["head"] not in revision_ids:
            raise ValueError("project head missing from bundle")
        for row in data["revisions"]:
            if row["project"] != project_id or (row["parent"] and row["parent"] not in revision_ids):
                raise ValueError("revision scope or parent mismatch")
            Document.model_validate(json.loads(row["document"]))
        source_ids = {row["id"] for row in data["sources"]}
        if any(row["project"] != project_id for row in data["sources"]):
            raise ValueError("source scope mismatch")
        from .engineering_memory import is_memory, parents, available
        source_payloads = {row["id"]: json.loads(row["payload"]) for row in data["sources"]}
        for source, payload in source_payloads.items():
            if is_memory(payload):
                if (payload.get("kind") not in ("requirement", "decision", "open_question", "stage")
                    or payload.get("status") not in ("active", "inactive", "superseded")
                    or ("confirmed" in payload and type(payload["confirmed"]) is not bool)
                    or payload.get("scope") not in ("project", "geometry", "revision")
                    or payload.get("revision_id") not in revision_ids
                    or not isinstance(payload.get("text"), str) or not 1 <= len(payload["text"]) <= 2000
                    or not isinstance(payload.get("derived_from"), list) or not parents(payload)
                    or any(not isinstance(item, str) or item not in source_ids for item in parents(payload))):
                    raise ValueError("invalid source-linked engineering memory")
                if payload.get("status") == "active" and not available(source_payloads, source):
                    raise ValueError("invalid or cyclic active memory lineage")
        for row in data["revisions"]:
            document = json.loads(row["document"])
            if any(item["source_event"] not in source_ids for item in [*document.get("requirements", []), *document.get("objects", [])]):
                raise ValueError("requirement source missing")
        for row in data["jobs"]:
            if not isinstance(row["id"], str) or not re.fullmatch(r"[a-f0-9]{32}", row["id"]):
                raise ValueError("invalid job identity")
            if row["project"] != project_id or row["revision"] not in revision_ids or row["kind"] not in ("cad", "fea"):
                raise ValueError("job scope mismatch")
            if row["state"] not in ("queued", "running", "cancelling", "succeeded", "failed", "cancelled", "timed_out", "interrupted") or (row["adopted_revision"] and row["adopted_revision"] not in revision_ids):
                raise ValueError("invalid job state or adopted revision")
        task_ids = {row["id"] for row in data["agent_tasks"]}
        job_ids = {row["id"] for row in data["jobs"]}
        task_configs = {}
        for row in data["agent_tasks"]:
            if not isinstance(row["id"], str) or not re.fullmatch(r"[a-f0-9]{32}", row["id"]):
                raise ValueError("invalid task identity")
            if row["project"] != project_id or row["revision"] not in revision_ids or row["source"] not in source_ids:
                raise ValueError("task scope mismatch")
            if type(row["epoch"]) is not int or row["epoch"] < 1 or row["state"] not in ("created", "executing", "waiting_job", "waiting_user", "completed", "cancelled"):
                raise ValueError("invalid task epoch or state")
            config = json.loads(row["config"])
            if not isinstance(config, dict):
                raise ValueError("invalid task configuration")
            if type(config.get("unlimited", False)) is not bool:
                raise ValueError("invalid unlimited task setting")
            task_configs[row["id"]] = config
            if config.get("mode") != "redacted":
                if config.get("mode") not in ("explicit-local-plan/1", "deepseek/1") or type(config.get("max_jobs")) is not int or not 1 <= config["max_jobs"] <= 8 or not isinstance(config.get("plan"), list):
                    raise ValueError("invalid task plan or budget")
                if config["mode"] == "explicit-local-plan/1" and not 1 <= len(config["plan"]) <= 24:
                    raise ValueError("invalid explicit task plan")
                if config["mode"] == "deepseek/1":
                    if config["plan"] or config.get("model") not in ("deepseek-flash", "deepseek-v4-pro") or config.get("data_scope") != "deepseek-project-context/1":
                        raise ValueError("invalid imported model task")
                    if type(config.get("max_requests")) is not int or not 1 <= config["max_requests"] <= 24 or config.get("max_total_tokens") != 250000 or config.get("max_seconds") != 600:
                        raise ValueError("invalid model task budgets")
                    if type(config.get("used_tokens")) is not int or config["used_tokens"] < 0 or (not config.get("unlimited") and config["used_tokens"] > 250000) or type(config.get("started_at")) not in (int, float) or not math.isfinite(config["started_at"]):
                        raise ValueError("invalid model task accounting")
                for item in config["plan"]:
                    TaskStep.model_validate(item)
            if any(type(row[key]) is not int or row[key] < 0 or (not config.get("unlimited") and row[key] > 24) for key in ("turns", "jobs")):
                raise ValueError("invalid task counters")
        for row in data["agent_turns"]:
            if row["task"] not in task_ids or row["revision"] not in revision_ids or (row["job"] and row["job"] not in job_ids):
                raise ValueError("task checkpoint scope mismatch")
            if type(row["epoch"]) is not int or row["epoch"] < 1 or type(row["ordinal"]) is not int or row["ordinal"] < 0 or (not task_configs[row["task"]].get("unlimited") and row["ordinal"] >= 24):
                raise ValueError("invalid checkpoint epoch or ordinal")
            if row["state"] not in ("requesting_model", "executing", "waiting_job", "succeeded", "failed", "superseded", "redacted", "rejected"):
                raise ValueError("invalid checkpoint state")
            for key in ("response", "arguments", "receipt"):
                if row[key] is not None:
                    json.loads(row[key])
        for row in data["receipts"]:
            if row["scope"] == project_id:
                continue
            response = json.loads(row["response"])
            if row["scope"] != "workspace" or not (response.get("task_id") in task_ids or (response.get("forgotten_source_ids") and set(response["forgotten_source_ids"]) <= source_ids)):
                raise ValueError("receipt scope mismatch")
        digests = set()
        for name in names - {"project.json"}:
            pieces = name.split("/")
            if len(pieces) != 3 or pieces[0] != "artifacts" or not re.fullmatch(r"[a-f0-9]{64}", pieces[1]) or not re.fullmatch(r"[a-zA-Z0-9_.-]+", pieces[2]) or pieces[2] in (".", ".."):
                raise ValueError("invalid bundle path")
            digests.add(pieces[1])
        # Publish only verified immutable artifacts. A failed metadata transaction
        # may leave unreferenced files, never a partially restored project head.
        dependencies = set()
        for digest in digests:
            prefix = f"artifacts/{digest}/"
            manifest = json.loads(bundle.read(prefix + "manifest.json"))
            if manifest.get('kind')=='code_module':
                if manifest.get('project')!=project_id or manifest.get('schema')!='vision.code-module/1' or set(manifest.get('files',{}))!={'module.py'}:
                    raise ValueError('invalid code module artifact contract')
            dependencies.update(item['code_revision'] for item in manifest.get('module_execution',{}).get('components',[]))
            if manifest.get("kind") == "cad":
                validate_cad(manifest)
            resolved_source = manifest.get("provenance", {}).get("resolved_source")
            if resolved_source:
                dependencies.add(resolved_source)
            legacy_source = manifest.get("provenance", {}).get("legacy_source")
            if legacy_source:
                dependencies.add(legacy_source)
            expected_names = {prefix + "manifest.json", *(prefix + name for name in manifest["files"])}
            if {name for name in names if name.startswith(prefix)} != expected_names:
                raise ValueError("artifact file list mismatch")
            if "input.json" in manifest["files"]:
                inputs = json.loads(bundle.read(prefix + "input.json"))
                source = inputs.get("document", {}).get("geometry")
                if source:
                    dependencies.add(source)
                replay = inputs.get("command", {}).get("replay_of")
                if replay:
                    dependencies.add(replay)
            with tempfile.TemporaryDirectory(prefix="import-", dir=workspace.root) as temporary:
                folder = Path(temporary)
                for name, expected in manifest["files"].items():
                    if Path(name).name != name or name in (".", "..", "manifest.json"):
                        raise ValueError("invalid artifact filename")
                    payload = bundle.read(prefix + name)
                    if hashlib.sha256(payload).hexdigest() != expected:
                        raise ValueError("artifact file checksum mismatch")
                    (folder / name).write_bytes(payload)
                published = workspace.artifacts.publish(folder, list(manifest["files"]),
                    {key: value for key, value in manifest.items() if key not in ("artifactId", "files")})
                if published["artifactId"] != digest or manifest.get("artifactId") != digest:
                    raise ValueError("artifact identity mismatch")
        references = {json.loads(row["document"])["geometry"] for row in data["revisions"]}
        references.update(json.loads(row["document"]).get("legacy_source") for row in data["revisions"])
        references.update(json.loads(row["result"])["artifact_id"] for row in data["jobs"] if row["result"])
        references.update(json.loads(row['payload'])['code_revision'] for row in data['sources']
                          if json.loads(row['payload']).get('origin')=='code_module' or json.loads(row['payload']).get('original_origin')=='code_module')
        if not ((references - {None}) | dependencies) <= digests:
            raise ValueError("referenced artifact missing from bundle")

    def restore(db):
        if db.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
            raise Conflict("recovery requires an empty workspace; existing projects were not changed")
        for table, columns in TABLES.items():
            for original in data[table]:
                row = dict(original)
                if table == "jobs":
                    if row["state"] in ("queued", "running", "cancelling"):
                        row.update(state="interrupted", error="imported pending execution was not replayed", updated=time.time())
                    if row["result"]:
                        row["result"] = packed({**json.loads(row["result"]), "origin": "imported"})
                if table == "sources":
                    payload = json.loads(row["payload"])
                    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str) or (not payload["text"].strip() and payload.get("origin") != "deleted"):
                        raise ValueError("invalid source payload")
                    if payload.get("origin") != "deleted":
                        row["payload"] = packed({**payload, "origin": "imported_source", "original_origin": payload.get("original_origin", payload.get("origin"))})
                if table == "agent_tasks":
                    if row["state"] in ("created", "executing", "waiting_job"):
                        row.update(state="waiting_user", epoch=row["epoch"] + 1, error="Imported task is paused; submit a new correction/plan to continue.")
                    row["config"] = packed({**json.loads(row["config"]), "origin": "imported"})
                placeholders = ",".join("?" for _ in columns)
                db.execute(f"INSERT INTO {table} ({','.join(columns)}) VALUES({placeholders})", tuple(row[key] for key in columns))
                if table == "jobs":
                    workspace.event(db, row["id"], row["state"], "Restored from bundle; imported evidence has not been recomputed.")
        return workspace._revision(db, project_id)
    return workspace.command("workspace", request, restore)
