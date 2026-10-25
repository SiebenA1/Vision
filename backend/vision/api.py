"""Standalone v2 API. Existing v1 application is not modified by this service."""
from contextlib import asynccontextmanager
import os
import errno
import sqlite3
from fastapi import FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response

from .contracts import AddObject, AddRequirement, AdoptGeometry, Build, ConfigureStudy, CorrectModelTask, CorrectTask, CreateModelTask, CreateProject, CreateTask, ForgetSource, InspectGeometry, LegacyImport, LegacyPreview, RebindObject, ReceiptInput, RemoveRequirement, Rename, Restore, Solve, StopTask
from .bundles import MAX_BUNDLE, export_project, import_project
from .migrations import import_legacy, legacy_geometry
from .assessment import assess
from .reports import report
from .studies import configure_study, validate_binding
from .jobs import Controller
from .storage import Conflict, Missing, Workspace
from .queries import Queries, QueryUnavailable
from .changes import preview_build
from .tasks import Tasks
from .task_memory import context, search
from . import conversation
from .contracts import ConversationMessage, DeleteProject, Edit, HumanMemory, MemoryState, ModelSettings, UISettings
from . import project_management
from . import verification
from . import code_modules
from .contracts import RegisterCodeModule, SearchCodeModules, ReadCodeModule
from .task_tools import PatchCodeModule, ReadCodeAssembly
from .contracts import BeamReference, VerifySolver


def create_app(root, *, run_jobs=True, cad_timeout=240, fea_timeout=600):
    workspace = Workspace(root)
    controller = Controller(workspace, cad_timeout=cad_timeout, fea_timeout=fea_timeout)
    queries = Queries(workspace)
    tasks = Tasks(workspace, queries)

    @asynccontextmanager
    async def lifespan(app):
        if run_jobs:
            controller.start()
            tasks.start()
        try:
            yield
        finally:
            queries.close()
            if run_jobs:
                tasks.close()
                controller.close()

    app = FastAPI(title="VISION engineering core", version="2.0.0-alpha", lifespan=lifespan)
    app.state.workspace = workspace
    app.state.controller = controller
    app.state.queries = queries
    app.state.tasks = tasks

    @app.exception_handler(QueryUnavailable)
    async def query_unavailable(request, error):
        return JSONResponse(status_code=error.status, content={"code": "QUERY_UNAVAILABLE", "detail": error.detail})

    @app.exception_handler(Conflict)
    async def conflict(request, error):
        return JSONResponse(status_code=409, content={"code": "CONFLICT", "detail": str(error)})

    @app.exception_handler(Missing)
    async def missing(request, error):
        return JSONResponse(status_code=404, content={"code": "NOT_FOUND", "detail": str(error)})

    @app.exception_handler(ValueError)
    async def invalid(request, error):
        return JSONResponse(status_code=422, content={"code": "INVALID_INPUT", "detail": str(error)})

    @app.exception_handler(sqlite3.OperationalError)
    async def storage_database_full(request, error):
        code = getattr(error, "sqlite_errorcode", 0) or 0
        if code & 0xff == sqlite3.SQLITE_CANTOPEN:
            return JSONResponse(status_code=503, content={"code": "STORAGE_UNAVAILABLE", "detail": "数据库无法打开所需文件，当前操作未提交。请检查工作区目录的访问权限与磁盘状态。"})
        if getattr(error, "sqlite_errorcode", None) != sqlite3.SQLITE_FULL:
            raise error
        return JSONResponse(status_code=507, content={"code": "STORAGE_FULL", "detail": "数据库空间不足，提交未完成。请释放空间后重试；已有工程版本保留。"})

    @app.exception_handler(OSError)
    async def storage_files_full(request, error):
        if error.errno != errno.ENOSPC:
            raise error
        return JSONResponse(status_code=507, content={"code": "STORAGE_FULL", "detail": "制品存储空间不足，提交未完成。请释放空间后重试；已有工程版本保留。"})

    @app.exception_handler(RequestValidationError)
    async def invalid_contract(request, error):
        # Do not echo script contents or non-JSON NaN/Infinity values in errors.
        return JSONResponse(status_code=422, content={"code": "INVALID_CONTRACT", "detail": [
            {key: item[key] for key in ("loc", "msg", "type")} for item in error.errors()]})

    @app.middleware("http")
    async def local_requests(request: Request, call_next):
        # This remains an explicitly local Python execution service.
        origin = request.headers.get("origin")
        if origin:
            from urllib.parse import urlsplit
            if urlsplit(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
                return JSONResponse(status_code=403, content={"detail": "local origin required"})
        size = request.headers.get("content-length")
        limit = MAX_BUNDLE if request.url.path in ("/api/v2/imports/bundle", "/api/v2/imports/legacy", "/api/v2/imports/preview") else 2 * 1024 * 1024
        if size and (not size.isdigit() or int(size) > limit):
            return JSONResponse(status_code=413, content={"detail": "request exceeds size limit"})
        return await call_next(request)

    @app.get("/api/v2/health")
    def health():
        from .runtime import memory_budget
        from .provider import status
        model = status(workspace.root)
        return {"schema": "vision.workspace/4", "api": "v2", "controller": bool(controller.thread and controller.thread.is_alive()),
                "task_mode": "explicit-local-plan/1", "external_model_enabled": model["configured"], "model": model,
                "physics": ["isotropic-linear-static"], "experimental": True,
                "worker_memory_limit_mib": memory_budget(), "query_memory_limit_mib": 1024 if os.name == "nt" else None}

    @app.post('/api/v2/projects/{project}/code-modules')
    def register_module(project:str,request:RegisterCodeModule):
        return code_modules.register(workspace,project,request.model_dump())

    @app.post('/api/v2/projects/{project}/code-modules/search')
    def search_modules(project:str,request:SearchCodeModules):
        return code_modules.search(workspace,project,request.model_dump())

    @app.post('/api/v2/projects/{project}/code-modules/read')
    def read_module(project:str,request:ReadCodeModule):
        return code_modules.read(workspace,project,request.model_dump())

    @app.post('/api/v2/projects/{project}/code-modules/patch')
    def patch_module(project:str,request:PatchCodeModule):
        return code_modules.patch_module(workspace,project,request.model_dump())

    @app.post('/api/v2/projects/{project}/code-assembly/read')
    def read_module_assembly(project:str,request:ReadCodeAssembly):
        return code_modules.read_assembly(workspace,project,request.model_dump())

    @app.get("/api/v2/model-settings")
    def get_model_settings():
        from .provider import status, MODELS
        return {**status(workspace.root), "models": MODELS}

    @app.post("/api/v2/calculations/beam")
    def calculate_beam(request: BeamReference):
        return verification.beam_reference(request.model_dump())

    @app.get("/api/v2/solver-checks")
    def solver_checks():
        return verification.list_runs(workspace)

    @app.post("/api/v2/solver-checks", status_code=202)
    def start_solver_check(request: VerifySolver):
        return verification.create(workspace, request.model_dump())

    @app.get("/api/v2/solver-checks/{run}")
    def solver_check(run: str):
        return verification.get(workspace, run)

    @app.post("/api/v2/solver-checks/{run}/cancel")
    def cancel_solver_check(run: str):
        return verification.cancel(workspace, run)

    @app.get("/api/v2/ui-settings")
    def get_ui_settings():
        import json
        with workspace.db() as db:
            row = db.execute("SELECT value FROM workspace_settings WHERE key='ui'").fetchone()
        return json.loads(row[0]) if row else {"theme": "system", "sidebar_collapsed": False, "chat_width": 380}

    @app.get("/api/v2/workspace-info")
    def workspace_info():
        with workspace.db() as db:
            counts = {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                      for table in ("projects", "revisions", "sources", "jobs")}
        return {"database": "SQLite", "counts": counts, "storage_path": str(workspace.root),
                "units": "mm / N / MPa / kg", "physics": "各向同性线弹性静力"}

    @app.post("/api/v2/ui-settings")
    def save_ui_settings(request: UISettings):
        from .storage import packed
        values = request.model_dump(exclude={"command_id", "idempotency_key"})
        def save(db):
            db.execute("INSERT OR REPLACE INTO workspace_settings VALUES('ui',?)", (packed(values),))
            return values
        return workspace.command("workspace", request.model_dump(), save)

    @app.post("/api/v2/model-settings")
    def save_model_settings(request: ModelSettings):
        from .storage import packed, identity
        # Atomic local preference; credentials remain backend environment/.env only.
        temporary = workspace.root / ("model-settings-" + identity() + ".tmp")
        try:
            temporary.write_text(packed({"model": request.model}), encoding="utf-8")
            os.replace(temporary, workspace.root / "model-settings.json")
        finally:
            temporary.unlink(missing_ok=True)
        return get_model_settings()

    @app.post("/api/v2/projects", status_code=201)
    def create(request: CreateProject):
        return workspace.create(request.model_dump())

    @app.get("/api/v2/projects")
    def projects():
        return workspace.projects()

    @app.post("/api/v2/projects/{project}/tasks", status_code=202)
    def create_task(project: str, request: CreateTask):
        return tasks.create(project, request.model_dump())

    @app.post("/api/v2/projects/{project}/model-tasks", status_code=202)
    def create_model_task(project: str, request: CreateModelTask):
        return tasks.create(project, request.model_dump(), model=True)

    @app.get("/api/v2/projects/{project}/tasks")
    def list_tasks(project: str):
        with workspace.db() as db:
            workspace._revision(db, project)
            ids = [row[0] for row in db.execute("SELECT id FROM agent_tasks WHERE project=? ORDER BY created DESC LIMIT 50", (project,))]
        return [tasks.get(task, include_steps=False) for task in ids]

    @app.get("/api/v2/projects/{project}/conversation")
    def get_conversation(project: str):
        return conversation.read(tasks, project)

    @app.post("/api/v2/projects/{project}/conversation", status_code=202)
    def send_message(project: str, request: ConversationMessage):
        return conversation.send(tasks, project, request.model_dump())

    @app.get("/api/v2/projects/{project}/sources/search")
    def find_sources(project: str, q: str = Query(min_length=1, max_length=2000)):
        return {"sources": search(workspace, project, q)}

    @app.get("/api/v2/memory/status")
    def memory_status():
        from .retrieval import status
        return status()

    @app.get("/api/v2/projects/{project}/memory")
    def project_memory(project: str):
        import json
        from .engineering_memory import available, entries
        current = workspace.revision(project)
        values = entries(workspace, project, current["revision_id"])
        with workspace.db() as db:
            rows = {row["id"]:json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=? ORDER BY created,id", (project,))}
            can_edit = not db.execute("SELECT 1 FROM agent_tasks WHERE project=? AND state IN ('created','executing','waiting_job') LIMIT 1", (project,)).fetchone()
            task = db.execute("SELECT id FROM agent_tasks WHERE project=? AND json_extract(config,'$.conversation')=1 ORDER BY created DESC LIMIT 1", (project,)).fetchone()
        sources, memo = [], {}
        for key, value in reversed(list(rows.items())):
            origin = value.get("original_origin", value.get("origin"))
            if origin not in ("user_task_input", "user_memory_input", "tool_receipt") or not available(rows, key, memo):
                continue
            sources.append({"source_id":key,"origin":origin,"text":value.get("text", "")[:160],"revision_id":value.get("revision_id")})
            if len(sources) == 100: break
        document = current["document"]
        return {"entries":values,"sources":sources,"can_edit":can_edit,"task_id":task[0] if task else None,
                "project":{"revision_id":current["revision_id"],"name":document["name"],"geometry_available":bool(document.get("geometry")),
                           "study_configured":bool(document.get("study")),"requirements":document.get("requirements",[])}}

    @app.post("/api/v2/projects/{project}/memory")
    def remember(project: str, request: HumanMemory):
        from .engineering_memory import record
        return record(workspace, project, request.model_dump())

    @app.post("/api/v2/projects/{project}/memory/state")
    def memory_state(project: str, request: MemoryState):
        from .engineering_memory import set_enabled
        return set_enabled(workspace, project, request.model_dump())

    @app.post("/api/v2/projects/{project}/sources/forget")
    def forget_source(project: str, request: ForgetSource):
        return tasks.forget(project, request.model_dump())

    @app.get("/api/v2/tasks/{task}")
    def get_task(task: str):
        return tasks.get(task)

    @app.get("/api/v2/tasks/{task}/input")
    def task_input(task: str):
        return tasks.inputs(task)

    @app.get("/api/v2/tasks/{task}/context")
    def task_context(task: str, view: str = Query(default="preview", pattern="^(preview|last-request)$")):
        value, turns = tasks.snapshot(task)
        if view == "last-request":
            import hashlib
            import json
            import zlib
            with workspace.db() as db:
                row = db.execute("SELECT c.*,t.epoch,t.ordinal,t.created,t.state,t.response FROM context_snapshots c JOIN agent_turns t ON t.id=c.turn WHERE t.task=? ORDER BY t.created DESC,t.ordinal DESC LIMIT 1", (task,)).fetchone()
            if not row:
                return {"mode":"last-request", "available":False, "notice":"尚无本地请求快照。旧版本请求、导入工程及已清除的快照无法还原。", "external_transmission":False}
            try:
                encoded = zlib.decompress(row["payload"])
            except zlib.error as error:
                raise ValueError("request context snapshot is corrupt") from error
            if hashlib.sha256(encoded).hexdigest() != row["sha256"]:
                raise ValueError("request context snapshot checksum mismatch")
            request, response = json.loads(encoded), json.loads(row["response"] or "{}")
            compiled = json.loads(request["messages"][1]["content"])
            return {"mode":"last-request", "available":True, "context":compiled, "request":request, "metadata":response.get("request",{}),
                "request_sha256":row["sha256"], "model":request["model"], "epoch":row["epoch"], "ordinal":row["ordinal"],
                "created":row["created"], "provider_confirmed":bool(response.get("provider",{}).get("response_id")),
                "notice":"发送前保存的原始上下文快照。供应商回执存在时才确认已收到请求；历史快照不代表当前工程状态。", "external_transmission":False}
        compiled, metadata = context(workspace, value, turns, budget=24000)
        return {"mode":"preview", "context": compiled, "metadata": metadata,
                "notice":"按当前数据重新编译的预览，不代表过去实际发送的内容。", "external_transmission": False}

    @app.post("/api/v2/tasks/{task}/correct")
    def correct_task(task: str, request: CorrectTask):
        return tasks.change(task, request.model_dump(), correct=True)

    @app.post("/api/v2/tasks/{task}/correct-model")
    def correct_model_task(task: str, request: CorrectModelTask):
        return tasks.change(task, request.model_dump(), correct=True, model=True)

    @app.post("/api/v2/tasks/{task}/cancel")
    def cancel_task(task: str, request: StopTask):
        return tasks.change(task, request.model_dump())

    @app.get("/api/v2/projects/{project}")
    def project_head(project: str):
        return workspace.revision(project)

    @app.get("/api/v2/projects/{project}/revisions")
    def history(project: str):
        return workspace.history(project)

    @app.get("/api/v2/projects/{project}/compare")
    def compare_revisions(project: str, left: str, right: str):
        from .comparisons import compare
        return compare(workspace, project, left, right)

    @app.get("/api/v2/projects/{project}/revisions/{revision}")
    def revision(project: str, revision: str):
        return workspace.revision(project, revision)

    @app.post("/api/v2/projects/{project}/study")
    def study(project: str, request: ConfigureStudy):
        def change(db, document):
            return {**document, "study": configure_study(workspace, document, request.study.model_dump(exclude_none=True))}
        return workspace.edit(project, request.model_dump(), change)

    @app.post("/api/v2/projects/{project}/rename")
    def rename(project: str, request: Rename):
        return project_management.rename(workspace, project, request.model_dump())

    @app.post("/api/v2/projects/{project}/stop")
    def stop_project(project: str, request: Edit):
        return project_management.stop(tasks, project, request.model_dump())

    @app.post("/api/v2/projects/{project}/delete")
    def delete_project(project: str, request: DeleteProject):
        return project_management.delete(workspace, project, request.model_dump())

    @app.post("/api/v2/projects/{project}/requirements")
    def add_requirement(project: str, request: AddRequirement):
        from .storage import identity, packed
        import time
        def change(db, document):
            source, requirement_id = identity(), identity()
            payload = {"origin": "structured_user_input", "text": request.statement, "requirement": request.requirement.model_dump()}
            db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, project, packed(payload), time.time()))
            requirement = {**request.requirement.model_dump(), "id": requirement_id, "source_event": source}
            return {**document, "requirements": [*document.get("requirements", []), requirement]}
        return workspace.edit(project, request.model_dump(), change)

    @app.post("/api/v2/projects/{project}/requirements/remove")
    def remove_requirement(project: str, request: RemoveRequirement):
        def change(db, document):
            requirements = document.get("requirements", [])
            if not any(item["id"] == request.requirement_id for item in requirements):
                raise Missing("requirement unavailable")
            return {**document, "requirements": [item for item in requirements if item["id"] != request.requirement_id]}
        return workspace.edit(project, request.model_dump(), change)

    @app.post("/api/v2/projects/{project}/objects")
    def add_object(project: str, request: AddObject):
        from .storage import identity, packed
        import time
        def change(db, document):
            binding = validate_binding(workspace, document, request.topology_ids, request.artifact_id)
            source, object_id = identity(), identity()
            payload = {"origin": "structured_user_input", "text": request.purpose, "name": request.name, "binding": binding}
            db.execute("INSERT INTO sources VALUES(?,?,?,?)", (source, project, packed(payload), time.time()))
            target = {"id": object_id, "name": request.name, "purpose": request.purpose, "source_event": source, "binding": binding}
            return {**document, "objects": [*document.get("objects", []), target]}
        return workspace.edit(project, request.model_dump(), change)

    @app.post("/api/v2/projects/{project}/inspect")
    def inspect_geometry(project: str, request: InspectGeometry):
        return queries.inspect(project, request.model_dump(exclude_none=True))

    @app.post("/api/v2/projects/{project}/objects/rebind")
    def rebind_object(project: str, request: RebindObject):
        def change(db, document):
            objects = document.get("objects", [])
            if not any(item["id"] == request.object_id for item in objects):
                raise Missing("engineering object unavailable")
            binding = validate_binding(workspace, document, request.topology_ids, request.artifact_id)
            return {**document, "objects": [{**item, "binding": binding} if item["id"] == request.object_id else item for item in objects]}
        return workspace.edit(project, request.model_dump(), change)

    @app.get("/api/v2/projects/{project}/sources/{source}")
    def source(project: str, source: str):
        import json
        with workspace.db() as db:
            row = db.execute("SELECT * FROM sources WHERE id=? AND project=?", (source, project)).fetchone()
            if not row:
                raise Missing("source unavailable in this project")
            return {"id": source, "payload": json.loads(row["payload"]), "created_at": row["created"]}

    @app.get("/api/v2/projects/{project}/assessments")
    def assessments(project: str, revision_id: str | None = None):
        return assess(workspace, project, revision_id)

    @app.get("/api/v2/projects/{project}/report")
    def report_file(project: str, revision_id: str | None = None):
        return Response(report(workspace, project, revision_id), media_type="text/markdown",
                        headers={"Content-Disposition": f'attachment; filename="VISION-{project}.md"'})

    @app.post("/api/v2/projects/{project}/restore")
    def restore(project: str, request: Restore):
        return workspace.edit(project, request.model_dump(), lambda db, doc: workspace._revision(db, project, request.revision_id)["document"])

    @app.post("/api/v2/projects/{project}/build", status_code=202)
    def build(project: str, request: Build):
        return workspace.enqueue(project, request.model_dump(), "cad")

    @app.post("/api/v2/projects/{project}/build/preview")
    def preview_geometry_change(project: str, request: Build):
        return preview_build(workspace, project, request.model_dump())

    @app.post("/api/v2/projects/{project}/adopt")
    def adopt(project: str, request: AdoptGeometry):
        def change(db, doc):
            row = db.execute("SELECT * FROM jobs WHERE id=? AND project=?", (request.job_id, project)).fetchone()
            if not row:
                raise Missing("candidate job unavailable in this project")
            if row["state"] != "succeeded" or row["kind"] != "cad":
                raise ValueError("only successful CAD candidates can be adopted")
            import json
            artifact = json.loads(row["result"])["artifact_id"]
            workspace.artifacts.manifest(artifact)
            return {**doc, "geometry": artifact}
        return workspace.edit(project, request.model_dump(), change)

    @app.post("/api/v2/projects/{project}/solve", status_code=202)
    def solve(project: str, request: Solve):
        return workspace.enqueue(project, request.model_dump(), "fea")

    @app.get("/api/v2/projects/{project}/jobs")
    def project_jobs(project: str):
        workspace.revision(project)
        with workspace.db() as db:
            ids = [row[0] for row in db.execute("SELECT id FROM jobs WHERE project=? ORDER BY created DESC LIMIT 100", (project,))]
        return [workspace.job(job) for job in ids]

    @app.get("/api/v2/jobs/{job}")
    def job_status(job: str):
        return workspace.job(job)

    @app.get("/api/v2/jobs/{job}/input")
    def job_input(job: str):
        workspace.job(job)
        import json
        with workspace.db() as db:
            return json.loads(db.execute("SELECT input FROM jobs WHERE id=?", (job,)).fetchone()[0])

    @app.get("/api/v2/jobs/{job}/events")
    def job_events(job: str, after: int = Query(default=0, ge=0)):
        return workspace.events(job, after)

    @app.post("/api/v2/jobs/{job}/cancel")
    def cancel(job: str):
        return workspace.cancel(job)

    @app.get("/api/v2/jobs/{job}/logs/{stream}")
    def logs(job: str, stream: str):
        workspace.job(job)
        if stream not in ("stdout", "stderr"):
            raise Missing("log stream unavailable")
        path = workspace.root / "runs" / job / f"{stream}.log"
        if not path.is_file():
            raise Missing("run log unavailable on this workspace")
        size = path.stat().st_size
        with path.open("rb") as file:
            file.seek(max(0, size - 65536))
            content = file.read(65536).decode("utf-8", errors="replace")
        return {"text": content[-16000:], "truncated": size > 65536 or len(content) > 16000}

    @app.get("/api/v2/artifacts/{artifact}/manifest")
    def manifest(artifact: str):
        return workspace.artifacts.manifest(artifact)

    @app.get("/api/v2/artifacts/{artifact}/files/{filename}")
    def artifact_file(artifact: str, filename: str):
        return FileResponse(workspace.artifacts.file(artifact, filename), filename=filename)

    @app.post("/api/v2/imports/preview")
    def preview(request: LegacyPreview):
        import hashlib
        from .storage import packed
        model = request.legacy_model
        if model.get("schema") != "vision.model/1" or not isinstance(model.get("id"), str) or not isinstance(model.get("name"), str):
            raise ValueError("expected a legacy vision.model/1 document")
        cad = model.get("cad") or {}
        digest = cad.get("artifactId") if isinstance(cad, dict) else None
        available = False
        issue = None
        try:
            legacy_geometry(model)
            available = True
        except ValueError as error:
            issue = str(error)
        return {"source_sha256": hashlib.sha256(packed(model).encode()).hexdigest(),
                "legacy_model_id": model["id"], "name": model["name"], "artifact_id": digest,
                "legacy_artifact_available": available, "has_saved_script": bool(model.get("externalScript")),
                "geometry_issue": issue,
                "warnings": ["Preview only: no project or memory has been imported.",
                             "Legacy revision labels do not reconstruct commit history.",
                             "Unsaved dialogue, decisions and result fields cannot be recovered from a model JSON."] +
                            ([] if available else ["Native artifact missing or unspecified; no script was executed to replace it."])}

    @app.post("/api/v2/imports/legacy", status_code=201)
    def migrate_legacy(request: LegacyImport):
        return import_legacy(workspace, request.model_dump(exclude_none=True))

    @app.get("/api/v2/projects/{project}/export")
    def export(project: str):
        return Response(export_project(workspace, project), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="VISION-{project}.zip"'})

    @app.post("/api/v2/imports/bundle", status_code=201)
    async def import_bundle(request: Request, x_command_id: str = Header(), idempotency_key: str = Header()):
        command = ReceiptInput(command_id=x_command_id, idempotency_key=idempotency_key)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > MAX_BUNDLE:
                return JSONResponse(status_code=413, content={"detail": "bundle exceeds size limit"})
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(import_project, workspace, bytes(data), command.model_dump())

    return app
