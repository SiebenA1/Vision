"""Versioned, source-linked memory. Summaries never become solver evidence."""
import json
import time

from .storage import Conflict, Missing, identity, packed


def parents(value):
    derived = value.get("derived_from", [])
    return [derived] if isinstance(derived, str) else derived if isinstance(derived, list) else []


def is_memory(value):
    return value.get("origin") == "engineering_memory" or (
        value.get("origin") == "imported_source" and value.get("original_origin") == "engineering_memory")


def applicable(value, current):
    if value.get("status", "active") != "active":
        return False
    if value.get("scope") == "geometry":
        return bool(current["document"].get("geometry")) and value.get("artifact_id") == current["document"].get("geometry")
    if value.get("scope") == "revision" or value.get("kind") == "stage":
        return value.get("revision_id") == current["revision_id"]
    return True


def context_eligible(rows, source, current):
    value = rows[source]
    if not is_memory(value):
        # Original receipts remain searchable as explicitly versioned history;
        # stale model summaries must not return as current memory.
        return value.get("status", "active") == "active" and (value.get("scope") != "geometry" or
            value.get("artifact_id") == current["document"].get("geometry"))
    def enabled(key):
        return not any(is_memory(rows.get(parent, {})) and not applicable(rows[parent], current)
                       for parent in lineage(rows, [key]))
    if not applicable(value, current) or (is_memory(value) and not enabled(source)):
        return False
    if is_memory(value) and value.get("kind") == "stage":
        for key, candidate in reversed(list(rows.items())):
            if is_memory(candidate) and candidate.get("kind") == "stage" and applicable(candidate, current) and enabled(key) and available(rows, key):
                return source == key
        return False
    return True


def lineage(rows, ids):
    found = set(ids)
    pending = list(ids)
    while pending:
        for source in parents(rows.get(pending.pop(), {})):
            if source not in found:
                found.add(source)
                pending.append(source)
    return sorted(found)


def available(rows, source, memo=None):
    """Iterative DAG validation also handles histories deeper than Python recursion."""
    memo = {} if memo is None else memo
    visiting, stack = set(), [(source, False)]
    while stack:
        node, expanded = stack.pop()
        if node in memo:
            continue
        if expanded:
            memo[node] = all(memo.get(parent, False) for parent in parents(rows[node]))
            visiting.discard(node)
        elif node in visiting:
            memo.update(dict.fromkeys(visiting, False))
            return False
        elif node not in rows or rows[node].get("origin") == "deleted":
            memo[node] = False
        else:
            visiting.add(node)
            stack.append((node, True))
            stack.extend((parent, False) for parent in reversed(parents(rows[node])))
    return memo.get(source, False)


def entries(workspace, project, revision=None):
    with workspace.db() as db:
        current = workspace._revision(db, project, revision)
        rows = {row["id"]: json.loads(row["payload"]) for row in db.execute(
            "SELECT id,payload FROM sources WHERE project=? ORDER BY created,id", (project,))}
    result, availability = [], {}
    latest_stage = next((key for key, value in reversed(list(rows.items())) if is_memory(value) and value.get("kind") == "stage"
                         and context_eligible(rows, key, current) and available(rows, key, availability)), None)
    for source, value in rows.items():
        if not is_memory(value) or not available(rows, source, availability):
            continue
        result.append({"source_id": source, **value,
            "applicable": context_eligible(rows, source, current) and (value.get("kind") != "stage" or source == latest_stage),
            "confirmed": value.get("confirmed", value.get("authored_by") == "user"),
            "current_geometry": value.get("scope") != "geometry" or value.get("artifact_id") == current["document"].get("geometry"),
            "current_revision": value.get("revision_id") == current["revision_id"],
            "source_ids": lineage(rows, [source]), "meaning": "source-linked summary, not numerical evidence"})
    return result


def record(workspace, project, request, *, fence=None, authored_by="user"):
    def action(db):
        current = workspace._revision(db, project)
        if authored_by == "user" and db.execute("SELECT 1 FROM agent_tasks WHERE project=? AND state IN ('created','executing','waiting_job') LIMIT 1", (project,)).fetchone():
            raise Conflict("请先停止当前执行，再整理或纠正工程记忆，避免旧计划继续使用修改前的要求。")
        rows = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=?", (project,))}
        for source in request["source_ids"]:
            if not available(rows, source):
                raise Missing("memory source unavailable in this project")
        source_ids = list(request["source_ids"])
        if not source_ids:
            if authored_by != "user":
                raise ValueError("model memory requires explicit sources")
            direct = identity()
            db.execute("INSERT INTO sources VALUES(?,?,?,?)", (direct, project, packed({"origin":"user_memory_input",
                "text":request["summary"], "revision_id":current["revision_id"], "meaning":"direct user record, not solver evidence"}), time.time()))
            source_ids = [direct]
        for source in request.get("supersedes", []):
            value = rows.get(source, {})
            if not is_memory(value) or value.get("status") not in ("active", "inactive"):
                raise Conflict("memory already changed; reload before correcting")
        if request["scope"] == "geometry" and not current["document"].get("geometry"):
            raise ValueError("geometry-scoped memory requires current geometry")
        source = identity()
        value = {"origin": "engineering_memory", "text": request["summary"], "kind": request["kind"],
            "status": "active", "scope": request["scope"], "authored_by": authored_by,
            "confirmed": authored_by == "user", "derived_from": source_ids, "supersedes": request.get("supersedes", []),
            "revision_id": current["revision_id"], "artifact_id": current["document"].get("geometry")}
        db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, project, packed(value), time.time()))
        for old in request.get("supersedes", []):
            db.execute("UPDATE sources SET payload=? WHERE id=? AND project=?",
                (packed({**rows[old], "status": "superseded", "superseded_by": source}), old, project))
        return {"source_id": source, "status": "active", "meaning": "summary, not verified engineering evidence"}
    return workspace.command(project, request, action, fence=fence)


def set_enabled(workspace, project, request):
    def action(db):
        current = workspace._revision(db, project)
        if current["revision_id"] != request["expected_head"]:
            raise Conflict("工程版本已变化，请刷新后操作。")
        if db.execute("SELECT 1 FROM agent_tasks WHERE project=? AND state IN ('created','executing','waiting_job') LIMIT 1", (project,)).fetchone():
            raise Conflict("请先停止当前执行，再调整工程上下文。")
        row = db.execute("SELECT payload FROM sources WHERE id=? AND project=?", (request["source_id"], project)).fetchone()
        value = json.loads(row[0]) if row else {}
        if not is_memory(value) or value.get("status") not in ("active", "inactive"):
            raise Conflict("该记录已被替代或不可用，请刷新查看。")
        value["status"] = "active" if request["enabled"] else "inactive"
        db.execute("UPDATE sources SET payload=? WHERE id=? AND project=?", (packed(value), request["source_id"], project))
        return {"source_id":request["source_id"], "status":value["status"], "meaning":"context use changed; records and engineering versions retained"}
    return workspace.command(project, request, action)


def checkpoint(db, task, turn, tool, receipt, revision):
    """An extractive stage checkpoint, with dependencies on every consumed source."""
    if tool in ("build_geometry", "configure_study", "solve", "assessment", "inspect_geometry"):
        archive_receipt(db, task, turn, tool, receipt, revision)
    if tool not in ("ask_user", "finish"):
        return
    dependencies = {task["source"]}
    tools = []
    for row in db.execute("SELECT response,receipt FROM agent_turns WHERE task=? AND epoch=? AND state='succeeded' ORDER BY ordinal", (task["id"], task["epoch"])):
        value = json.loads(row[0])
        dependencies.update(value.get("request", {}).get("source_ids", []))
        step_receipt = json.loads(row[1])
        dependencies.update(step_receipt.get("source_ids", []))
        if step_receipt.get("source_id"):
            dependencies.add(step_receipt["source_id"])
        tools.append(value["tool"])
    rows = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=?", (task["project"],))}
    # Store direct dependencies; ancestors remain reachable without quadratic copies.
    ancestors = set()
    for dependency in dependencies:
        ancestors.update(set(lineage(rows, [dependency])) - {dependency})
    dependencies -= ancestors
    source = identity()
    value = {"origin": "engineering_memory", "kind": "stage", "status": "active", "scope": "revision",
        "text": receipt.get("question", receipt.get("summary", ""))[:2000], "authored_by": "model_checkpoint",
        "derived_from": sorted(dependencies), "revision_id": revision, "task_id": task["id"],
        "epoch": task["epoch"], "turn_id": turn, "tools": tools,
        "meaning": "extractive model checkpoint; inspect original tool receipts for evidence"}
    db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, task["project"], packed(value), time.time()))


def archive_receipt(db, task, turn, tool, receipt, revision):
    import uuid
    # Do not index executable scripts, job input documents or raw field arrays.
    if "job" in receipt:
        receipt = {"job": {key: receipt["job"].get(key) for key in ("id", "kind", "state", "result", "error", "adopted_revision")}}
    source = uuid.uuid5(uuid.NAMESPACE_URL, "vision/tool-receipt/" + turn).hex
    response = db.execute("SELECT response FROM agent_turns WHERE id=?", (turn,)).fetchone()
    dependencies = {task["source"]} | set(json.loads(response[0]).get("request", {}).get("source_ids", [])) if response else {task["source"]}
    value = {"origin": "tool_receipt", "text": packed({"tool": tool, "receipt": receipt}),
        "scope": "revision", "revision_id": revision, "task_id": task["id"], "turn_id": turn,
        "derived_from": sorted(dependencies), "meaning": "original tool receipt at its recorded revision; not proof for later revisions"}
    db.execute("INSERT OR IGNORE INTO sources VALUES(?,?,?,?)", (source, task["project"], packed(value), time.time()))
