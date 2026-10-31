"""Persistent explicit/model tasks with epoch-fenced tool checkpoints."""
import hashlib
import json
import logging
import threading
import time

from .storage import Conflict, Missing, identity, packed
from .task_memory import context
from .task_tools import analysis_receipt, execute, prepare, TOOL_REGISTRY
from .queries import QueryUnavailable
from . import model_tasks
from .engineering_memory import parents, checkpoint
from .model_io import ModelIO, RequestCancelled

ACTIVE = ("created", "executing", "waiting_job")


class Tasks:
    def __init__(self, workspace, queries, *, model_transport=None):
        self.workspace, self.queries = workspace, queries
        self.stop = threading.Event()
        self.thread = None
        self.model_transport = model_transport
        self.model_io = None
        self.model_requests = {}
        self.schedule_cursor = 0

    def start(self):
        self.model_io = ModelIO(self.model_transport)
        try:
            self.model_io.start()
        except Exception:
            self.model_io.close()
            raise
        self.thread = threading.Thread(target=self.loop, name="vision-tasks", daemon=True)
        try:
            self.thread.start()
        except Exception:
            self.model_io.close()
            raise

    def close(self):
        self.stop.set()
        if self.model_io:
            self.model_io.cancel_all()
        if self.thread and self.thread.ident is not None:
            self.thread.join(timeout=25)
            if self.thread.is_alive():
                raise RuntimeError("task runner did not stop; controller ownership must be retained")
        if self.model_io:
            self.model_io.close()
            for prepared in self.model_requests.values():
                task = prepared['task']
                self.update(task['id'], task['epoch'], 'waiting_user',
                            'model request stopped during shutdown; outcome may be unknown, no automatic retry')
            self.model_requests.clear()

    def row(self, db, task):
        value = db.execute("SELECT * FROM agent_tasks WHERE id=?", (task,)).fetchone()
        if not value:
            raise Missing("task unavailable")
        return dict(value)

    def snapshot(self, task):
        with self.workspace.db() as db:
            return self.row(db, task), [dict(row) for row in db.execute("SELECT * FROM agent_turns WHERE task=? ORDER BY epoch,ordinal", (task,))]

    def get(self, task, include_steps=True):
        if include_steps:
            value, turns = self.snapshot(task)
        else:
            with self.workspace.db() as db:
                value, turns = self.row(db, task), []
        value["config"] = json.loads(value["config"])
        value["config"].pop("plan", None)
        for turn in turns:
            for key in ("response", "arguments", "receipt"):
                turn[key] = json.loads(turn[key]) if turn[key] else None
            turn.pop("arguments", None)
            if turn["response"]:
                turn["response"] = {key: turn["response"][key] for key in ("tool", "provider", "request", "execution") if key in turn["response"]}
        value["steps"] = turns if include_steps else []
        value['current_epoch_reported_tokens'] = sum(
            (turn['response'] or {}).get('provider', {}).get('usage', {}).get('total_tokens', 0)
            for turn in turns if turn['epoch'] == value['epoch']) if include_steps else None
        return value

    def inputs(self, task):
        value, _ = self.snapshot(task)
        with self.workspace.db() as db:
            source = json.loads(db.execute("SELECT payload FROM sources WHERE id=? AND project=?", (value["source"], value["project"])).fetchone()[0])
        config = json.loads(value["config"])
        return {"statement": source.get("text", ""), "plan": config["plan"], "epoch": value["epoch"],
                "mode": config["mode"], "max_jobs": config["max_jobs"], "max_requests": config.get("max_requests", 12)}

    def receipt(self, operation, request, action):
        # User statements stay in sources, not duplicated in command receipts.
        compact = {"command_id": request["command_id"], "idempotency_key": request["idempotency_key"],
                   "operation": operation, "payload_sha256": hashlib.sha256(packed(request).encode()).hexdigest()}
        return self.workspace.command("workspace", compact, action)

    def source(self, db, project, task, epoch, statement):
        source = identity()
        db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, project, packed({"origin": "user_task_input", "text": statement,
                   "task_id": task, "epoch": epoch}), time.time()))
        return source

    def create(self, project, request, model=False):
        model_config = model_tasks.configuration(request, self.workspace.root) if model else None
        def create(db):
            revision = self.workspace._revision(db, project)
            if revision["revision_id"] != request["expected_head"]:
                raise Conflict("project changed before task creation")
            active = db.execute("SELECT count(*) FROM agent_tasks WHERE state IN ('created','executing','waiting_job')").fetchone()[0]
            if active >= 8:
                raise ValueError("at most 8 local tasks may be active")
            task, now = identity(), time.time()
            source = self.source(db, project, task, 1, request["statement"])
            config = packed(model_config or {"mode": "explicit-local-plan/1", "plan": request["plan"], "max_jobs": request["max_jobs"]})
            db.execute("INSERT INTO agent_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (task, project, revision["revision_id"], 1,
                "created", source, config, "", None, 0, 0, now, now))
            return {"task_id": task, "epoch": 1, "state": "created"}
        return self.receipt("create_model_task" if model else "create_task", {**request, "project_id": project}, create)

    def cancel_owned(self, db, task, epoch):
        for step in db.execute("SELECT id,job,arguments,response,receipt FROM agent_turns WHERE task=? AND epoch=?", (task, epoch)).fetchall():
            if step['receipt'] and json.loads(step['response'] or '{}').get('tool') == 'read_batch':
                receipt = json.loads(step['receipt'])
                for call in receipt.get('calls', []):
                    if call['state'] in ('executing', 'not_started'):
                        call.update(state='cancelled' if call['state'] == 'executing' else 'cancelled_before_start',
                                    error='task corrected or stopped; no result adopted')
                db.execute('UPDATE agent_turns SET receipt=? WHERE id=?', (packed(receipt), step['id']))
            job = step["job"]
            if not job and step["arguments"]:
                command = json.loads(step["arguments"]).get("command_id")
                receipt = db.execute("SELECT response FROM receipts WHERE command_id=? AND scope=(SELECT project FROM agent_tasks WHERE id=?)", (command, task)).fetchone() if command else None
                if receipt:
                    job = json.loads(receipt[0]).get("job_id")
            if job:
                row = db.execute("SELECT state FROM jobs WHERE id=? AND project=(SELECT project FROM agent_tasks WHERE id=?)", (job, task)).fetchone()
                if row and row[0] in ("queued", "running"):
                    state = "cancelled" if row[0] == "queued" else "cancelling"
                    db.execute("UPDATE jobs SET state=?,updated=? WHERE id=?", (state, time.time(), job))
                    self.workspace.event(db, job, state, "Task corrected or stopped.")

    def change(self, task, request, correct=False, model=False):
        model_config = model_tasks.configuration(request, self.workspace.root) if model else None
        def change(db):
            current = self.row(db, task)
            if current["epoch"] != request["expected_epoch"]:
                raise Conflict("task epoch changed")
            revision = self.workspace._revision(db, current["project"])["revision_id"]
            if correct and revision != request["expected_head"]:
                raise Conflict("project head changed; review the current revision before correcting this task")
            if correct and current["state"] not in ACTIVE and db.execute(
                    "SELECT count(*) FROM agent_tasks WHERE state IN ('created','executing','waiting_job')").fetchone()[0] >= 8:
                raise ValueError("at most 8 local tasks may be active")
            self.cancel_owned(db, task, current["epoch"])
            db.execute("UPDATE agent_turns SET state='superseded' WHERE task=? AND epoch=? AND state IN ('requesting_model','executing','waiting_job')", (task, current["epoch"]))
            epoch = current["epoch"] + 1
            config = json.loads(current["config"])
            source = current["source"]
            if correct:
                if config["mode"] == "redacted":
                    raise Conflict("source was forgotten; create a new task instead")
                if model != (config["mode"] == model_tasks.MODE):
                    raise Conflict("use the correction endpoint matching the original task mode")
                source = self.source(db, current["project"], task, epoch, request["statement"])
                config = model_config or {**config, "plan": request["plan"]}
                config.pop("context", None)
            state = "created" if correct else "cancelled"
            db.execute("UPDATE agent_tasks SET revision=?,epoch=?,state=?,source=?,config=?,summary='',error=NULL,turns=0,jobs=0,updated=? WHERE id=?",
                       (revision, epoch, state, source, packed(config), time.time(), task))
            return {"task_id": task, "epoch": epoch, "state": state}
        result = self.receipt("correct_model_task" if model else "correct_task" if correct else "stop_task", {**request, "task_id": task}, change)
        if self.model_io:
            self.model_io.cancel_owner(task, request['expected_epoch'])
        return result

    def forget(self, project, request):
        def forget(db):
            self.workspace._revision(db, project)
            rows = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=?", (project,))}
            if request["source_id"] not in rows:
                raise Missing("source unavailable in this project")
            # Request snapshots can contain copied source text. Forgetting a
            # source removes project snapshots as well, never just its index.
            db.execute("DELETE FROM context_snapshots WHERE project=?", (project,))
            affected = {request["source_id"]}
            while True:
                expanded = affected | {key for key, value in rows.items() if affected.intersection(parents(value))}
                if expanded == affected:
                    break
                affected = expanded
            candidates = {rows[key]["task_id"] for key in affected if isinstance(rows[key].get("task_id"), str)}
            # Retrieval receipts are derived copies too. Stop/redact tasks that
            # consumed a forgotten source so old tool groups cannot recall it.
            for turn in db.execute("SELECT t.task,t.receipt,t.response FROM agent_turns t JOIN agent_tasks a ON a.id=t.task WHERE a.project=?", (project,)):
                receipt = json.loads(turn["receipt"]) if turn["receipt"] else {}
                sources = receipt.get("sources", []) if isinstance(receipt, dict) else []
                if isinstance(receipt, dict) and receipt.get("source_id") in affected:
                    candidates.add(turn["task"])
                if isinstance(receipt, dict) and affected.intersection(receipt.get("source_ids", [])):
                    candidates.add(turn["task"])
                if isinstance(sources, list) and any(isinstance(item, dict) and isinstance(item.get("source_id"), str)
                        and item["source_id"] in affected for item in sources):
                    candidates.add(turn["task"])
                response = json.loads(turn["response"]) if turn["response"] else {}
                metadata = response.get("request") if isinstance(response, dict) else None
                source_ids = metadata.get("source_ids", []) if isinstance(metadata, dict) else []
                if isinstance(source_ids, list) and any(isinstance(source, str) and source in affected for source in source_ids):
                    candidates.add(turn["task"])
            tasks = {task for task in candidates if db.execute("SELECT 1 FROM agent_tasks WHERE id=? AND project=?", (task, project)).fetchone()}
            for task in tasks:
                current = self.row(db, task)
                self.cancel_owned(db, task, current["epoch"])
                db.execute("UPDATE agent_tasks SET epoch=epoch+1,state='cancelled',summary='',error='Source forgotten',config=?,updated=? WHERE id=?",
                           (packed({"mode": "redacted", "plan": [], "max_jobs": 0}), time.time(), task))
                db.execute("UPDATE agent_turns SET response=NULL,arguments=NULL,receipt=NULL,error='Source forgotten',state='redacted' WHERE task=?", (task,))
            for source in affected:
                db.execute("UPDATE sources SET payload=? WHERE id=? AND project=?", (packed({"origin": "deleted", "text": ""}), source, project))
                db.execute("DELETE FROM source_fts WHERE id=? AND project=?", (source, project))
            # Project receipts may contain original structured statements. Keep
            # only their hashes for deduplication. Committed design snapshots stay.
            for row in db.execute("SELECT key,request FROM receipts WHERE scope=?", (project,)).fetchall():
                if not row["request"].startswith("sha256:"):
                    db.execute("UPDATE receipts SET request=? WHERE scope=? AND key=?",
                               ("sha256:" + hashlib.sha256(row["request"].encode()).hexdigest(), project, row["key"]))
            return {"forgotten_source_ids": sorted(affected), "cancelled_task_ids": sorted(tasks),
                    "retained": "Committed project revisions, engineering artifacts and existing exported backups are retained."}
        result = self.receipt("forget_source", {**request, "project_id": project}, forget)
        if self.model_io:
            for task in result['cancelled_task_ids']:
                with self.workspace.db() as db:
                    current = self.row(db, task)
                self.model_io.cancel_owner(task, current['epoch'] - 1)
        from .retrieval import clear_project_cache
        clear_project_cache(self.workspace, project)
        return result

    def update(self, task, epoch, state, error=None):
        with self.workspace.db() as db:
            if not db.execute("SELECT 1 FROM agent_tasks WHERE id=?", (task,)).fetchone():
                return  # A permanently deleted project cannot accept late replies.
            current = self.row(db, task)
            if current["epoch"] != epoch or current["state"] == "cancelled":
                return
            db.execute("UPDATE agent_turns SET state='failed',error=? WHERE task=? AND epoch=? AND state IN ('requesting_model','executing','waiting_job')", (error, task, epoch))
            db.execute("UPDATE agent_tasks SET state=?,error=?,updated=? WHERE id=? AND epoch=? AND state!='cancelled'",
                       (state, error, time.time(), task, epoch))

    def loop(self):
        while not self.stop.is_set():
            try:
                self.reconcile_requests()
                with self.workspace.db() as db:
                    ids = [row[0] for row in db.execute("SELECT id FROM agent_tasks WHERE state IN ('created','executing','waiting_job') ORDER BY created LIMIT 8")]
            except Exception:
                logging.exception('task scheduling snapshot failed; retrying reconciliation')
                self.stop.wait(.2)
                continue
            if ids:
                offset = self.schedule_cursor % len(ids)
                ids = ids[offset:] + ids[:offset]
                self.schedule_cursor += 1
            for task in ids:
                if self.stop.is_set():
                    break
                try:
                    self.step(task)
                except Exception:
                    logging.exception("local task checkpoint failed; retrying reconciliation")
            self.stop.wait(.2)

    def reconcile_requests(self):
        """Cancel obsolete I/O, including project deletion outside task endpoints."""
        for key, prepared in list(self.model_requests.items()):
            task = prepared['task']
            with self.workspace.db() as db:
                current = db.execute('SELECT epoch,state FROM agent_tasks WHERE id=?', (task['id'],)).fetchone()
                head = db.execute('SELECT head FROM projects WHERE id=?', (task['project'],)).fetchone()
            obsolete = (not current or current['epoch'] != task['epoch'] or current['state'] != 'executing'
                        or not head or head[0] != task['revision'])
            if obsolete:
                self.model_io.cancel(key)
                result = self.model_io.take(key)
                if result is not None:
                    del self.model_requests[key]
                    if current and current['epoch'] == task['epoch'] and current['state'] == 'executing':
                        self.update(task['id'], task['epoch'], 'waiting_user', 'project changed during model request; no tool executed')

    def step(self, task_id):
        task, turns = self.snapshot(task_id)
        if task["state"] not in ACTIVE:
            return
        if task['state'] != 'waiting_job' and any(
                entry['task']['project'] == task['project'] and entry['task']['id'] != task_id
                for entry in self.model_requests.values()):
            return
        epoch, config = task["epoch"], json.loads(task["config"])
        try:
            if task["state"] == "created":
                if self.workspace.revision(task["project"])["revision_id"] != task["revision"]:
                    raise Conflict("project changed; correct the task before continuing")
                _, config["context"] = context(self.workspace, task, turns, budget=24000 if config['mode'] == model_tasks.MODE else 60000)
                with self.workspace.db() as db:
                    db.execute("UPDATE agent_tasks SET state='executing',config=?,updated=? WHERE id=? AND epoch=? AND state='created'",
                               (packed(config), time.time(), task_id, epoch))
                return
            pending = next((turn for turn in turns if turn["epoch"] == epoch and turn["state"] in ("requesting_model", "executing", "waiting_job")), None)
            if pending and pending["state"] == "requesting_model":
                prepared = self.model_requests.get(pending['id'])
                if not prepared:
                    raise ValueError("model request outcome unknown after interruption; no automatic retry, submit a correction")
                result = self.model_io.take(pending['id'])
                if result is None:
                    return
                del self.model_requests[pending['id']]
                if result.error:
                    with self.workspace.db() as db:
                        current = self.row(db, task_id)
                        if current['epoch'] == epoch and current['state'] == 'executing':
                            response = json.loads(pending['response'])
                            response['execution'] = {'model_duration_ms': result.duration_ms,
                                                     'outcome': 'cancelled' if isinstance(result.error, RequestCancelled) else 'failed'}
                            db.execute('UPDATE agent_turns SET response=? WHERE id=?', (packed(response), pending['id']))
                    raise result.error
                task, turns, config = (prepared[key] for key in ('task', 'turns', 'config'))
                pending = model_tasks.settle_request(self, prepared, result.response, result.duration_ms)
                if pending is None:
                    return
            if not pending:
                if config["mode"] != model_tasks.MODE and task["turns"] >= len(config["plan"]):
                    with self.workspace.db() as db:
                        db.execute("UPDATE agent_tasks SET state='completed',summary=?,updated=? WHERE id=? AND epoch=? AND state='executing'",
                            (f"已完成 {task['turns']} 个显式计划步骤；工程结论以工具证据和指标核验为准。", time.time(), task_id, epoch))
                    return
                if self.workspace.revision(task["project"])["revision_id"] != task["revision"]:
                    raise Conflict("project changed; old plan cannot continue")
                if config["mode"] == model_tasks.MODE:
                    pending = model_tasks.next_step(self, task, turns, config)
                    if pending is None:
                        return
                else:
                    item = config["plan"][task["turns"]]
                    arguments = prepare(task, item, turns, self.workspace)
                    is_job = item["tool"] in ("build_geometry", "solve")
                    if is_job and task["jobs"] >= config["max_jobs"]:
                        raise ValueError("task job budget reached")
                    with self.workspace.db() as db:
                        current = self.row(db, task_id)
                        if current["epoch"] != epoch or current["state"] != "executing":
                            return
                        pending = {"id": identity(), "state": "executing", "arguments": packed(arguments), "response": packed(item)}
                        db.execute("INSERT INTO agent_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (pending["id"], task_id, epoch, task["turns"],
                            task["revision"], "executing", pending["response"], pending["arguments"], None, None, None, time.time()))
                        db.execute("UPDATE agent_tasks SET turns=turns+1,updated=? WHERE id=?", (time.time(), task_id))
            tool = json.loads(pending["response"])["tool"]
            execution = None
            if pending["state"] == "waiting_job":
                job = self.workspace.job(pending["job"])
                if job["state"] in ("queued", "running", "cancelling"):
                    return
                if job["state"] != "succeeded":
                    failures = sum(turn['epoch'] == epoch and turn['state'] == 'failed'
                                   and json.loads(turn.get('receipt') or '{}').get('recoverable', False) for turn in turns)
                    recoverable = (config['mode'] == model_tasks.MODE and tool == 'build_geometry' and job['state'] == 'failed'
                                   and (job.get('error') or '').startswith(('CadScriptFailure:', 'RuntimeError: CadScriptFailure:'))
                                   and failures < 2)
                    if recoverable:
                        error = job['error'][:2000]
                        receipt = {'job': {key: job.get(key) for key in ('id', 'kind', 'state', 'error')},
                                   'recoverable': True, 'project_unchanged': True,
                                   'next_action': 'Read the failed inputs with read_tool_result, correct the script, then preview/build changed inputs.'}
                        with self.workspace.db() as db:
                            current = self.row(db, task_id)
                            if current['epoch'] != epoch or current['state'] != 'waiting_job':
                                return
                            if self.workspace._revision(db, task['project'])['revision_id'] != task['revision']:
                                raise Conflict('project changed after failed job; old plan cannot continue')
                            db.execute("UPDATE agent_turns SET state='failed',receipt=?,error=? WHERE id=?",
                                       (packed(receipt), error, pending['id']))
                            from .engineering_memory import archive_receipt
                            archive_receipt(db, task, pending['id'], tool, receipt, task['revision'])
                            db.execute("UPDATE agent_tasks SET state='executing',error=NULL,updated=? WHERE id=?",
                                       (time.time(), task_id))
                        return
                    raise ValueError("task native job did not succeed: " + (job["error"] or job["state"]))
                receipt = analysis_receipt(job) if tool == "solve" else {"job": job, "origin": "verified_tool_receipt"}
                revision = job.get("adopted_revision") or task["revision"]
                if tool == 'build_geometry':
                    from .modeling import assess_geometry
                    receipt['modeling_check'] = assess_geometry(self.workspace, task['project'], revision)
                    artifact = receipt['modeling_check'].get('artifact_id')
                    if artifact:
                        from .modeling import geometry_summary
                        room = min(3500, 15500-len(packed(receipt)))
                        if room >= 400:
                            receipt['geometry_summary'] = geometry_summary(self.workspace.artifacts.manifest(artifact), room)
            else:
                # Epoch is checked again in the same transaction as every write.
                current, _ = self.snapshot(task_id)
                if current["epoch"] != epoch or current["state"] != "executing":
                    return
                started = time.monotonic()
                receipt = execute(self.workspace, self.queries, task, tool, json.loads(pending["arguments"]))
                execution = {'duration_ms': round((time.monotonic() - started) * 1000, 3),
                             'resource': TOOL_REGISTRY[tool].resource}
                revision = receipt.get("revision_id", task["revision"]) if tool in ("configure_study", 'set_modeling_requirements') else task["revision"]
            with self.workspace.db() as db:
                current = self.row(db, task_id)
                if current["epoch"] != epoch or current["state"] not in ("executing", "waiting_job"):
                    return
                if execution is not None:
                    response = {**json.loads(pending['response']), 'execution': execution}
                    db.execute('UPDATE agent_turns SET response=? WHERE id=?', (packed(response), pending['id']))
                if tool == 'finish' and self.workspace._revision(db, task['project'])['revision_id'] != revision:
                    raise Conflict('project changed before finish checkpoint')
                if tool in ("search_sources", "read_source", "read_tool_result", 'set_modeling_requirements', 'check_modeling', 'finish',
                            'register_code_module','search_code_modules','read_code_module','patch_code_module','read_code_assembly', 'read_batch'):
                    for source in receipt["sources"] if tool == "search_sources" else [{"source_id": key} for key in receipt["source_ids"]]:
                        stored = db.execute("SELECT payload FROM sources WHERE id=? AND project=?", (source["source_id"], task["project"])).fetchone()
                        if not stored or json.loads(stored[0]).get("origin") == "deleted":
                            raise Conflict("retrieved source was forgotten before checkpoint; correct the task")
                    if tool == 'set_modeling_requirements' or (receipt.get('completion') or receipt).get('status') == 'checks_passed':
                        from .engineering_memory import context_eligible, available
                        sources = {row['id']: json.loads(row['payload']) for row in db.execute('SELECT id,payload FROM sources WHERE project=?', (task['project'],))}
                        current_revision = self.workspace._revision(db, task['project'], revision)
                        if any(not available(sources, key) or not context_eligible(sources, key, current_revision)
                               for key in receipt['source_ids']):
                            raise Conflict('modeling requirement source changed before checkpoint')
                if "job_id" in receipt:
                    db.execute("UPDATE agent_turns SET job=?,state='waiting_job',receipt=? WHERE id=?", (receipt["job_id"], packed(receipt), pending["id"]))
                    db.execute("UPDATE agent_tasks SET state='waiting_job',jobs=jobs+1,updated=? WHERE id=?", (time.time(), task_id))
                else:
                    encoded = packed(receipt)
                    if len(encoded) > (24000 if tool == 'finish' else 16000):
                        raise ValueError("tool receipt exceeds task context limit")
                    state = "waiting_user" if tool == "ask_user" else "completed" if tool == "finish" else "executing"
                    db.execute("UPDATE agent_turns SET state='succeeded',receipt=? WHERE id=?", (encoded, pending["id"]))
                    checkpoint(db, task, pending["id"], tool, receipt, revision)
                    db.execute("UPDATE agent_tasks SET state=?,revision=?,summary=?,updated=? WHERE id=?", (state, revision,
                        receipt.get("question", receipt.get("summary", "")), time.time(), task_id))
        except (ValueError, Conflict, Missing, OSError, QueryUnavailable) as error:
            self.update(task_id, epoch, "waiting_user", str(error)[:2000])
