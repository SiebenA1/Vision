"""Permanent project deletion, fenced stop and reference-aware file cleanup."""
import json
import logging
from hashlib import sha256
from pathlib import Path
import shutil
import time

from .storage import Conflict, Missing, packed


def active(db, project):
    return db.execute("SELECT 1 FROM jobs WHERE project=? AND state IN ('queued','running','cancelling') LIMIT 1", (project,)).fetchone() or db.execute(
        "SELECT 1 FROM agent_tasks WHERE project=? AND state IN ('created','executing','waiting_job') LIMIT 1", (project,)).fetchone()


def rename(workspace, project, request):
    def change(db, document):
        if request.get("require_idle") and active(db, project):
            raise Conflict("工程正在执行任务，请等待完成或停止后再重命名。")
        return {**document, "name": request["name"]}
    return workspace.edit(project, request, change)


def stop(tasks, project, request):
    def action(db):
        revision = tasks.workspace._revision(db, project)
        if revision["revision_id"] != request["expected_head"]:
            raise Conflict("工程版本已变化，请核对后重新操作。")
        for row in db.execute("SELECT id,epoch FROM agent_tasks WHERE project=? AND state IN ('created','executing','waiting_job','waiting_user')", (project,)).fetchall():
            tasks.cancel_owned(db, row["id"], row["epoch"])
            db.execute("UPDATE agent_turns SET state='superseded' WHERE task=? AND state IN ('requesting_model','executing','waiting_job')", (row["id"],))
            db.execute("UPDATE agent_tasks SET state='cancelled',epoch=epoch+1,updated=? WHERE id=?", (time.time(), row["id"]))
        for row in db.execute("SELECT id,state FROM jobs WHERE project=? AND state IN ('queued','running')", (project,)).fetchall():
            state = "cancelled" if row["state"] == "queued" else "cancelling"
            db.execute("UPDATE jobs SET state=?,updated=? WHERE id=?", (state, time.time(), row["id"]))
            tasks.workspace.event(db, row["id"], state, "Stopped for project deletion.")
        return {"project_id": project, "state": "stopping"}
    return tasks.receipt("stop_project", {**request, "project_id": project}, action)


def artifact_roots(db, project=None):
    roots = set()
    clause, args = (" WHERE project=?", (project,)) if project else ("", ())
    for row in db.execute('SELECT payload FROM sources'+clause,args):
        value=json.loads(row[0])
        if value.get('origin')=='code_module' or value.get('original_origin')=='code_module':
            roots.add(value['code_revision'])
    for row in db.execute("SELECT document FROM revisions" + clause, args):
        doc = json.loads(row[0])
        roots.update(value for value in (doc.get("geometry"), doc.get("legacy_source")) if value)
    for row in db.execute("SELECT input,result FROM jobs" + clause, args):
        data = json.loads(row[0])
        roots.update(value for value in (data.get("document", {}).get("geometry"), data.get("command", {}).get("replay_of")) if value)
        if row[1]:
            roots.add(json.loads(row[1])["artifact_id"])
    return roots


def dependencies(workspace, roots):
    pending, found = list(roots), set()
    while pending:
        digest = pending.pop()
        if digest in found:
            continue
        found.add(digest)
        manifest = workspace.artifacts.manifest(digest)
        pending.extend(item['code_revision'] for item in manifest.get('module_execution',{}).get('components',[]))
        provenance = manifest.get("provenance", {})
        pending.extend(value for value in (provenance.get("resolved_source"), provenance.get("legacy_source")) if value)
        if "input.json" in manifest["files"]:
            inputs = json.loads(workspace.artifacts.file(digest, "input.json").read_text(encoding="utf-8"))
            pending.extend(value for value in (inputs.get("document", {}).get("geometry"), inputs.get("command", {}).get("replay_of")) if value)
    return found


def delete(workspace, project, request):
    def action(db):
        revision = workspace._revision(db, project)
        if revision["revision_id"] != request["expected_head"] or revision["document"]["name"] != request["confirmed_name"]:
            raise Conflict("工程名称或版本已变化，请重新确认删除。")
        if active(db, project):
            raise Conflict("仍有工程任务或作业未停止，请等待停止完成后再删除。")
        artifacts = artifact_roots(db, project)
        cleanup_notes = []
        try:
            artifacts = dependencies(workspace, artifacts)
        except (Missing, ValueError, OSError):
            cleanup_notes.append("工程记录已删除；部分缺失或损坏的制品依赖无法完整核对。")
        revisions = {row[0] for row in db.execute("SELECT id FROM revisions WHERE project=?", (project,))}
        # A cancelled worker can publish before its result is adopted. Include
        # those orphan outputs only when their verified provenance belongs here.
        for folder in workspace.artifacts.root.iterdir():
            if len(folder.name) != 64 or folder.is_symlink() or folder.is_junction() or not folder.is_dir():
                continue
            try:
                manifest = workspace.artifacts.manifest(folder.name)
                if (manifest.get("provenance", {}).get("revision_id") in revisions
                        or manifest.get('kind') == 'code_module' and manifest.get('project') == project):
                    artifacts.add(folder.name)
            except (Missing, ValueError, OSError):
                continue
        jobs = [row[0] for row in db.execute("SELECT id FROM jobs WHERE project=?", (project,))]
        task_ids = {row[0] for row in db.execute("SELECT id FROM agent_tasks WHERE project=?", (project,))}
        source_ids = {row[0] for row in db.execute("SELECT id FROM sources WHERE project=?", (project,))}
        for row in db.execute("SELECT key,response FROM receipts WHERE scope='workspace'").fetchall():
            response = json.loads(row["response"])
            if response.get("project_id") == project or response.get("task_id") in task_ids or source_ids.intersection(response.get("forgotten_source_ids", [])):
                db.execute("DELETE FROM receipts WHERE scope='workspace' AND key=?", (row["key"],))
        db.execute("DELETE FROM agent_turns WHERE task IN (SELECT id FROM agent_tasks WHERE project=?)", (project,))
        db.execute("DELETE FROM agent_tasks WHERE project=?", (project,))
        db.execute("DELETE FROM source_fts WHERE project=?", (project,))
        db.execute("DELETE FROM sources WHERE project=?", (project,))
        db.execute("DELETE FROM job_events WHERE job IN (SELECT id FROM jobs WHERE project=?)", (project,))
        db.execute("DELETE FROM jobs WHERE project=?", (project,))
        db.execute("DELETE FROM receipts WHERE scope=?", (project,))
        db.execute("DELETE FROM revisions WHERE project=?", (project,))
        db.execute("DELETE FROM projects WHERE id=?", (project,))
        return {"deleted_project_id": project, "state": "deleted", "cleanup_artifacts": sorted(artifacts), "cleanup_jobs": jobs, "cleanup_notes": cleanup_notes}
    compact = {"command_id": request["command_id"], "idempotency_key": request["idempotency_key"],
               "project_id": project, "operation": "delete_project", "payload_sha256": sha256(packed(request).encode()).hexdigest()}
    result = workspace.command("workspace", compact, action)
    warnings = list(result.get("cleanup_notes", []))
    try:
        from .retrieval import clear_project_cache
        clear_project_cache(workspace, project)
    except Exception:
        # The deletion is already committed. A rebuildable index must not turn
        # that success into an HTTP failure and invite a second delete request.
        logging.getLogger(__name__).exception("Project deleted but retrieval cache cleanup failed")
        warnings.append("工程记录已删除，但检索缓存清理失败；请重启本地工程服务以清空缓存。")
    # Metadata is committed before file cleanup. Keep referenced/shared geometry.
    try:
        with workspace.db() as db:
            retained = dependencies(workspace, artifact_roots(db))
            targets = [(workspace.artifacts.root, digest) for digest in set(result["cleanup_artifacts"]) - retained]
            targets.extend((workspace.root / "runs", job) for job in result["cleanup_jobs"])
            for root, name in targets:
                target = (root / name).resolve()
                if target.parent != root.resolve() or target.name != name or (root / name).is_symlink() or (root / name).is_junction():
                    raise ValueError("cleanup path escaped project storage")
                try:
                    if target.exists():
                        shutil.rmtree(target)
                except OSError:
                    warnings.append("工程记录已删除，但部分本地文件清理失败。")
    except Exception:
        # Nothing after the committed command can roll back project deletion.
        # Keep uncertain files rather than reporting a failed delete or removing
        # artifacts whose references could not be established.
        logging.getLogger(__name__).exception("Project deleted but file cleanup failed")
        warnings.append("工程记录已删除，部分文件待清理；其他工程数据保留。")
    return {"deleted_project_id": project, "state": "deleted", "warnings": list(dict.fromkeys(warnings))}
