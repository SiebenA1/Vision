"""One persistent conversation per project, backed by existing bundled sources/turns."""
import json
import time

from . import model_tasks
from .storage import Conflict, identity, packed


def read(tasks, project):
    messages = []
    task_id = None
    with tasks.workspace.db() as db:
        revision = tasks.workspace._revision(db, project)
        source_rows = {}
        for row in db.execute("SELECT * FROM sources WHERE project=? ORDER BY created,id", (project,)):
            source = json.loads(row["payload"])
            source_rows[row['id']] = source
            if not source.get("conversation") or source.get("origin") == "deleted":
                continue
            task_id = source["task_id"]
            messages.append({"id": row["id"], "role": "user", "text": source["text"], "created": row["created"],
                             "reference": source.get("reference"), "revision_id": source.get("revision_id")})
        for row in db.execute("SELECT t.id,t.receipt,t.created,t.revision FROM agent_turns t JOIN agent_tasks a ON a.id=t.task "
                "WHERE a.project=? AND json_extract(a.config,'$.conversation')=1 AND t.state='succeeded' AND t.receipt IS NOT NULL "
                "AND (json_extract(t.receipt,'$.summary') IS NOT NULL OR json_extract(t.receipt,'$.question') IS NOT NULL) "
                "ORDER BY t.created,t.ordinal", (project,)):
            receipt = json.loads(row["receipt"])
            text = receipt.get("question") or receipt.get("summary")
            if isinstance(text, str) and text:
                completion = receipt.get('completion')
                if completion:
                    from .task_memory import current_receipt
                    checked = current_receipt(source_rows, revision, 'check_modeling', completion)
                    if checked.get('context_status'):
                        completion = {**completion, 'status':'needs_review', 'checks': [],
                                      'notice':'要求来源或工程版本已变化，历史检查需要重新核验。'}
                messages.append({"id": row["id"], "role": "assistant", "text": text, "created": row["created"],
                                 "revision_id": row["revision"], 'completion': completion})
    messages.sort(key=lambda item: (item["created"], item["id"]))
    task = tasks.get(task_id) if task_id else None
    return {"messages": messages, "task": task if task and task["config"].get("conversation") else None}


def send(tasks, project, request):
    config = model_tasks.configuration({"max_jobs": 3, "max_requests": 12, "unlimited": True}, tasks.workspace.root)
    config["conversation"] = True

    def action(db):
        revision = tasks.workspace._revision(db, project)
        if revision["revision_id"] != request["expected_head"]:
            raise Conflict("工程版本已变化，请核对当前模型后重新发送。")
        existing = [dict(row) for row in db.execute("SELECT * FROM agent_tasks WHERE project=? ORDER BY created DESC,id", (project,))]
        current = next((row for row in existing if json.loads(row["config"]).get("conversation")), None)
        if (request.get("expected_task"), request.get("expected_epoch")) != ((current["id"], current["epoch"]) if current else (None, None)):
            raise Conflict("对话已在其他页面更新，请查看新消息后重新发送。")
        if any(row["state"] in ("created", "executing", "waiting_job") and (not current or row["id"] != current["id"]) for row in existing):
            raise Conflict("工程仍有其他任务执行，请先停止该任务再发送。")
        if (not current or current["state"] not in ("created", "executing", "waiting_job")) and db.execute(
                "SELECT count(*) FROM agent_tasks WHERE state IN ('created','executing','waiting_job')").fetchone()[0] >= 8:
            raise Conflict("工程服务当前繁忙，请等待其他任务结束后重试。")
        reference = None
        if request["selection"]:
            artifact = request["artifact_id"]
            if not artifact or artifact != revision["document"]["geometry"]:
                raise Conflict("所选模型已经变化，请重新选择对象。")
            manifest = tasks.workspace.artifacts.manifest(artifact)
            ids = {body["id"] for body in manifest["bodies"]}
            ids.update(item["id"] for body in manifest["bodies"] for kind in ("faces", "edges") for item in body[kind])
            if len(set(request["selection"])) != len(request["selection"]) or not set(request["selection"]) <= ids:
                raise ValueError("选择包含无效或重复的原生对象。")
            reference = {"revision_id": revision["revision_id"], "artifact_id": artifact, "selection": request["selection"]}
        task, now = (current["id"] if current else identity()), time.time()
        epoch = current["epoch"] + 1 if current else 1
        if current:
            tasks.cancel_owned(db, task, current["epoch"])
            db.execute("UPDATE agent_turns SET state='superseded' WHERE task=? AND state IN ('requesting_model','executing','waiting_job')", (task,))
        source = tasks.source(db, project, task, epoch, request["text"])
        payload = json.loads(db.execute("SELECT payload FROM sources WHERE id=?", (source,)).fetchone()[0])
        reply_to = None
        if current and current['state'] == 'waiting_user':
            previous_question = db.execute("SELECT id FROM agent_turns WHERE task=? AND epoch=? AND state='succeeded' "
                "AND json_extract(response,'$.tool')='ask_user' ORDER BY ordinal DESC LIMIT 1", (task, current['epoch'])).fetchone()
            reply_to = previous_question[0] if previous_question else None
        db.execute("UPDATE sources SET payload=? WHERE id=?", (packed({**payload, "conversation": True,
            "reference": reference, "revision_id": revision["revision_id"], "reply_to_turn_id": reply_to}), source))
        if current:
            # Retain actual usage across messages. A new instruction changes epoch, not history.
            previous = json.loads(current["config"])
            config["used_tokens"] = previous.get("used_tokens", 0)
            db.execute("UPDATE agent_tasks SET revision=?,epoch=?,state='created',source=?,config=?,summary='',error=NULL,turns=0,jobs=0,updated=? WHERE id=?",
                       (revision["revision_id"], epoch, source, packed(config), now, task))
        else:
            db.execute("INSERT INTO agent_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (task, project, revision["revision_id"], epoch, "created", source, packed(config), "", None, 0, 0, now, now))
        return {"task_id": task, "epoch": epoch, "message_id": source}
    return tasks.receipt("conversation_message", {**request, "project_id": project}, action)
