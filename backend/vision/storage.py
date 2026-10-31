"""Short SQLite transactions and immutable filesystem artifacts."""
from contextlib import contextmanager
from hashlib import sha256
import json
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
import threading
import uuid


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def identity():
    return uuid.uuid4().hex


class Conflict(ValueError):
    pass


class Missing(LookupError):
    pass


class Artifacts:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def manifest(self, digest):
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("invalid artifact identity")
        path = self.root / digest / "manifest.json"
        if not path.is_file():
            raise Missing("artifact unavailable")
        value = json.loads(path.read_text(encoding="utf-8"))
        if value["artifactId"] != digest:
            raise ValueError("artifact manifest identity mismatch")
        expected = sha256(packed({k: v for k, v in value.items() if k != "artifactId"}).encode()).hexdigest()
        if expected != digest:
            raise ValueError("artifact manifest checksum mismatch")
        return value

    def file(self, digest, name):
        manifest = self.manifest(digest)
        if name not in manifest["files"] or Path(name).name != name:
            raise Missing("artifact file unavailable")
        path = self.root / digest / name
        if sha256(path.read_bytes()).hexdigest() != manifest["files"][name]:
            raise ValueError("artifact file checksum mismatch")
        return path

    def publish(self, folder, names, metadata):
        folder = Path(folder)
        if any(Path(name).name != name or name == "manifest.json" for name in names):
            raise ValueError("invalid artifact filename")
        files = {name: sha256((folder / name).read_bytes()).hexdigest() for name in sorted(names)}
        manifest = {**metadata, "files": files}
        digest = sha256(packed(manifest).encode()).hexdigest()
        manifest["artifactId"] = digest
        staging = Path(tempfile.mkdtemp(prefix=".publish-", dir=self.root))
        try:
            for name in names:
                shutil.copyfile(folder / name, staging / name)
            (staging / "manifest.json").write_text(packed(manifest), encoding="utf-8")
            try:
                os.rename(staging, self.root / digest)
            except PermissionError:
                # Some Windows directories allow creating files but deny child
                # directory renames or hard links. Create files exclusively and
                # write the checksum-validated manifest last as the commit record.
                target = self.root / digest
                if target.is_symlink() or target.is_junction():
                    raise ValueError("artifact target must not be a link")
                target.mkdir(exist_ok=True)
                for name, expected in {**files, "manifest.json": sha256(packed(manifest).encode()).hexdigest()}.items():
                    destination = target / name
                    try:
                        with destination.open("xb") as output, (staging / name).open("rb") as source:
                            shutil.copyfileobj(source, output)
                            output.flush()
                            os.fsync(output.fileno())
                    except FileExistsError:
                        if destination.is_symlink() or sha256(destination.read_bytes()).hexdigest() != expected:
                            raise ValueError("existing artifact file checksum mismatch")
                self.manifest(digest)
            except OSError:
                if not (self.root / digest).is_dir():
                    raise
                self.manifest(digest)
                for name in files:
                    self.file(digest, name)
        finally:
            if staging.exists():
                if staging.resolve().parent != self.root.resolve():
                    raise ValueError("artifact staging cleanup escaped its storage root")
                try:
                    shutil.rmtree(staging)
                except PermissionError:
                    # An orphan staging folder is not a failed publication.
                    logging.getLogger(__name__).warning("Artifact staging cleanup denied: %s", staging)
        return manifest


class Workspace:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.artifacts = Artifacts(self.root / "artifacts")
        self.path = self.root / "workspace.sqlite3"
        self.retrieval_lock = threading.RLock()
        probe = sqlite3.connect(self.path)
        try:
            version = probe.execute("PRAGMA user_version").fetchone()[0]
        finally:
            probe.close()
        if version not in (0, 1, 2, 3, 4):
            raise ValueError("unsupported workspace schema version")
        lock = None
        try:
            if version in (1, 2, 3):
                from .processes import ControllerLock
                lock = ControllerLock(self.root / "controller.lock")
                source = sqlite3.connect(self.path)
                target = sqlite3.connect(self.root / f"workspace.schema{version}-{identity()}.sqlite3")
                try:
                    source.backup(target)
                finally:
                    source.close()
                    target.close()
            self._initialize()
        finally:
            if lock:
                lock.close()

    def _initialize(self):
        with self.db() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, 3, 4):
                raise ValueError("unsupported workspace schema version")
            db.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, head TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), parent TEXT, document TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS receipts(scope TEXT NOT NULL, key TEXT NOT NULL, command_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,key), UNIQUE(scope,command_id));
                CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), revision TEXT NOT NULL REFERENCES revisions(id), kind TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, adopted_revision TEXT, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,created);
                CREATE TABLE IF NOT EXISTS job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, detail TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), revision TEXT NOT NULL REFERENCES revisions(id), epoch INTEGER NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL REFERENCES sources(id), config TEXT NOT NULL, summary TEXT NOT NULL, error TEXT, turns INTEGER NOT NULL, jobs INTEGER NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS agent_turns(id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES agent_tasks(id), epoch INTEGER NOT NULL, ordinal INTEGER NOT NULL, revision TEXT NOT NULL REFERENCES revisions(id), state TEXT NOT NULL, response TEXT, arguments TEXT, receipt TEXT, job TEXT REFERENCES jobs(id), error TEXT, created REAL NOT NULL, UNIQUE(task,epoch,ordinal));
                CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(id UNINDEXED, project UNINDEXED, tokens);
                CREATE TABLE IF NOT EXISTS retrieval_queue(id TEXT PRIMARY KEY, project TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS retrieval_chunks(id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, project TEXT NOT NULL, text TEXT NOT NULL, digest TEXT NOT NULL, offset INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS retrieval_project ON retrieval_chunks(project,source);
                CREATE TABLE IF NOT EXISTS retrieval_vectors(id TEXT NOT NULL REFERENCES retrieval_chunks(id) ON DELETE CASCADE, model TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(id,model));
                CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(id UNINDEXED, project UNINDEXED, tokens);
                CREATE TABLE IF NOT EXISTS retrieval_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TRIGGER IF NOT EXISTS retrieval_generation_insert AFTER INSERT ON sources BEGIN
                    INSERT INTO retrieval_state VALUES('source_generation:' || new.project,'1')
                    ON CONFLICT(key) DO UPDATE SET value=CAST(retrieval_state.value AS INTEGER)+1;
                END;
                CREATE TRIGGER IF NOT EXISTS retrieval_generation_update AFTER UPDATE ON sources BEGIN
                    INSERT INTO retrieval_state VALUES('source_generation:' || new.project,'1')
                    ON CONFLICT(key) DO UPDATE SET value=CAST(retrieval_state.value AS INTEGER)+1;
                    INSERT INTO retrieval_state SELECT 'source_generation:' || old.project,'1' WHERE old.project<>new.project
                    ON CONFLICT(key) DO UPDATE SET value=CAST(retrieval_state.value AS INTEGER)+1;
                END;
                CREATE TRIGGER IF NOT EXISTS retrieval_generation_delete AFTER DELETE ON sources BEGIN
                    INSERT INTO retrieval_state VALUES('source_generation:' || old.project,'1')
                    ON CONFLICT(key) DO UPDATE SET value=CAST(retrieval_state.value AS INTEGER)+1;
                END;
                INSERT OR IGNORE INTO retrieval_state SELECT 'source_generation:' || id,'0' FROM projects;
                CREATE TABLE IF NOT EXISTS workspace_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS verification_runs(id TEXT PRIMARY KEY, suite TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL, result TEXT, error TEXT, phase TEXT, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS context_snapshots(turn TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE, project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, sha256 TEXT NOT NULL, payload BLOB NOT NULL);
                CREATE TRIGGER IF NOT EXISTS retrieval_source_insert AFTER INSERT ON sources BEGIN
                    INSERT OR REPLACE INTO retrieval_queue VALUES(new.id,new.project);
                END;
                CREATE TRIGGER IF NOT EXISTS retrieval_source_update AFTER UPDATE ON sources BEGIN
                    INSERT OR REPLACE INTO retrieval_queue VALUES(new.id,new.project);
                    DELETE FROM retrieval_fts WHERE id IN (SELECT id FROM retrieval_chunks WHERE source=old.id);
                    DELETE FROM retrieval_chunks WHERE source=old.id;
                END;
                CREATE TRIGGER IF NOT EXISTS retrieval_source_delete BEFORE DELETE ON sources BEGIN
                    INSERT OR REPLACE INTO retrieval_queue VALUES(old.id,old.project);
                    DELETE FROM retrieval_fts WHERE id IN (SELECT id FROM retrieval_chunks WHERE source=old.id);
                    DELETE FROM retrieval_chunks WHERE source=old.id;
                END;
                INSERT OR IGNORE INTO retrieval_queue SELECT id,project FROM sources WHERE NOT EXISTS (SELECT 1 FROM retrieval_state WHERE key='initialized');
                INSERT OR IGNORE INTO retrieval_state VALUES('initialized','1');
                PRAGMA user_version=4;
                COMMIT;
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            # FTS cleanup triggers and cascading deletes use temporary tables.
            # Windows services may inherit an inaccessible TEMP directory; keep
            # SQLite scratch tables in memory while durable data stays in WAL.
            db.execute("PRAGMA temp_store=MEMORY")
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _revision(self, db, project, revision=None):
        owner = db.execute("SELECT * FROM projects WHERE id=?", (project,)).fetchone()
        if not owner:
            raise Missing("project unavailable")
        row = db.execute("SELECT * FROM revisions WHERE id=? AND project=?", (revision or owner["head"], project)).fetchone()
        if not row:
            raise Missing("revision unavailable")
        return {"project_id": project, "revision_id": row["id"], "head_revision_id": owner["head"],
                "parent_revision_id": row["parent"], "document": json.loads(row["document"]), "created_at": row["created"]}

    def revision(self, project, revision=None):
        with self.db() as db:
            return self._revision(db, project, revision)

    def projects(self):
        with self.db() as db:
            return [self._revision(db, row[0]) for row in db.execute("SELECT id FROM projects ORDER BY rowid DESC").fetchall()]

    def history(self, project):
        with self.db() as db:
            self._revision(db, project)
            return [self._revision(db, project, row[0]) for row in db.execute("SELECT id FROM revisions WHERE project=? ORDER BY created DESC,rowid DESC", (project,)).fetchall()]

    def _commit(self, db, project, parent, document):
        from .contracts import Document
        Document.model_validate(document)
        revision = identity()
        db.execute("INSERT INTO revisions VALUES(?,?,?,?,?)", (revision, project, parent, packed(document), time.time()))
        db.execute("UPDATE projects SET head=? WHERE id=?", (revision, project))
        return self._revision(db, project, revision)

    def command(self, scope, request, action, fence=None):
        payload = packed(request)
        with self.db() as db:
            if fence:
                task = db.execute("SELECT epoch,state FROM agent_tasks WHERE id=? AND project=?", (fence[0], scope)).fetchone()
                if not task or task["epoch"] != fence[1] or task["state"] != "executing":
                    raise Conflict("task was corrected or stopped; old tools are fenced")
            old = db.execute("SELECT * FROM receipts WHERE scope=? AND (key=? OR command_id=?)", (scope, request["idempotency_key"], request["command_id"])).fetchall()
            if old:
                if len(old) != 1 or old[0]["request"] not in (payload, "sha256:" + sha256(payload.encode()).hexdigest()):
                    raise Conflict("command identity reused with different input")
                return json.loads(old[0]["response"])
            if scope != "workspace":
                current = self._revision(db, scope)
                if current["head_revision_id"] != request["expected_head"]:
                    raise Conflict("project changed; reload the current head")
            reply = action(db)
            db.execute("INSERT INTO receipts VALUES(?,?,?,?,?)", (scope, request["idempotency_key"], request["command_id"], payload, packed(reply)))
            return reply

    def create(self, request):
        def run(db):
            project = identity()
            db.execute("INSERT INTO projects VALUES(?,?)", (project, "pending"))
            return self._commit(db, project, None, {"schema_version": "vision.project/2", "name": request["name"], "geometry": None, "study": None})
        return self.command("workspace", request, run)

    def edit(self, project, request, change, fence=None):
        def run(db):
            current = self._revision(db, project)
            return self._commit(db, project, current["revision_id"], change(db, current["document"]))
        return self.command(project, request, run, fence=fence)

    def event(self, db, job, state, detail=""):
        db.execute("INSERT INTO job_events(job,state,detail,created) VALUES(?,?,?,?)", (job, state, detail, time.time()))

    def enqueue(self, project, request, kind, fence=None):
        from .runtime import execution_settings
        execution = execution_settings(kind)
        def run(db):
            document = self._revision(db, project)["document"]
            command = request
            if kind == "cad":
                from .changes import build_impact
                if request.get('module_assembly'):
                    from .code_modules import resolve
                    script, modules = resolve(self,project,document,request['module_assembly'],request.get('use_current',True),db)
                    if request.get('script') and request['script'] != script:
                        raise Conflict('module plan or reusable inputs changed; preview the current plan again')
                    command = {**request,'script':script}
                impact = build_impact(self, document, command)
                if request.get("expected_impact_digest") and request["expected_impact_digest"] != impact["digest"]:
                    raise Conflict("build preview no longer matches inputs; review the updated impact")
            if kind == "fea" and (not document["geometry"] or not document["study"]):
                raise ValueError("build geometry and explicitly configure a study before solving")
            if document["geometry"]:
                geometry = self.artifacts.manifest(document["geometry"])
                if kind == "fea":
                    from .studies import native_study
                    study = native_study(document)
                    selected = study.get("body_ids")
                    bodies = {body["id"]: body for body in geometry["bodies"]}
                    if selected is not None and any(item not in bodies or bodies[item]["kind"] != "solid" for item in selected):
                        raise ValueError("select current solid bodies")
                    for item in study["supports"] + study["loads"]:
                        region = item.get("region")
                        if item["enabled"] and region and region["type"] == "cad-face":
                            known = {face["id"] for body in geometry["bodies"] for face in body["faces"]}
                            if region["artifactId"] != document["geometry"] or not set(region["faceIds"]) <= known:
                                raise ValueError("native faces need rebinding to the current geometry")
            job, now = identity(), time.time()
            if kind == 'cad' and request.get('module_assembly'):
                command = {**command, '_module_execution':modules}
            data = {"document": document, "command": command, "execution": execution}
            db.execute("INSERT INTO jobs(id,project,revision,kind,input,state,created,updated) VALUES(?,?,?,?,?,?,?,?)",
                       (job, project, request["expected_head"], kind, packed(data), "queued", now, now))
            self.event(db, job, "queued")
            return {"job_id": job, "revision_id": request["expected_head"]}
        return self.command(project, request, run, fence=fence)

    def job(self, job):
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job,)).fetchone()
            if not row:
                raise Missing("job unavailable")
            result = dict(row)
            result["result"] = json.loads(row["result"]) if row["result"] else None
            phase = db.execute("SELECT detail FROM job_events WHERE job=? AND state='stage' ORDER BY seq DESC LIMIT 1", (job,)).fetchone()
            result["phase"] = phase[0] if phase else None
            del result["input"]
            return result

    def stage(self, job, detail):
        with self.db() as db:
            row = db.execute("SELECT state FROM jobs WHERE id=?", (job,)).fetchone()
            if row and row[0] in ("running", "cancelling"):
                self.event(db, job, "stage", detail[:500])

    def events(self, job, after):
        self.job(job)
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT * FROM job_events WHERE job=? AND seq>? ORDER BY seq LIMIT 200", (job, after))]

    def cancel(self, job):
        with self.db() as db:
            row = db.execute("SELECT state FROM jobs WHERE id=?", (job,)).fetchone()
            if not row:
                raise Missing("job unavailable")
            if row[0] in ("cancelled", "cancelling"):
                return {"state": row[0]}
            if row[0] not in ("queued", "running"):
                raise Conflict("job is already terminal")
            state = "cancelled" if row[0] == "queued" else "cancelling"
            db.execute("UPDATE jobs SET state=?,updated=? WHERE id=?", (state, time.time(), job))
            self.event(db, job, state)
            return {"state": state}

    def recover(self):
        with self.db() as db:
            pending = [row[0] for row in db.execute("SELECT id FROM jobs WHERE state IN ('running','cancelling')").fetchall()]
        for job in pending:
            receipt = self.root / "runs" / job / "receipt.json"
            if receipt.is_file():
                try:
                    value = json.loads(receipt.read_text(encoding="utf-8"))
                    if "error" in value:
                        self.finish(job, "failed", error=value["error"])
                    else:
                        self.finish(job, "succeeded", value["result"])
                    continue
                except (ValueError, KeyError, TypeError, OSError, Missing) as error:
                    reason = f"unverified recovery receipt: {error}"
            else:
                reason = "controller stopped before a complete worker receipt"
            self.finish(job, "interrupted", error=reason)

    def claim(self):
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created,rowid LIMIT 1").fetchone()
            if not row:
                return None
            db.execute("UPDATE jobs SET state='running',updated=? WHERE id=?", (time.time(), row["id"]))
            self.event(db, row["id"], "running")
            return {**dict(row), "input": json.loads(row["input"])}

    def finish(self, job, state, result=None, error=None):
        if state == "succeeded":
            # File verification can be expensive; do it outside the head transaction.
            with self.db() as db:
                original = db.execute("SELECT * FROM jobs WHERE id=?", (job,)).fetchone()
            if not original:
                raise Missing("job unavailable")
            artifact = self.artifacts.manifest(result["artifact_id"])
            if artifact["kind"] != original["kind"]:
                raise ValueError("worker artifact kind mismatch")
            provenance = artifact.get("provenance", {})
            if provenance.get("revision_id") != original["revision"] or provenance.get("input_sha256") != sha256(original["input"].encode()).hexdigest():
                raise ValueError("worker artifact does not match this job input")
            for filename in artifact["files"]:
                self.artifacts.file(result["artifact_id"], filename)
            result = {"artifact_id": artifact["artifactId"], **({"summary": artifact["result"]} if original["kind"] == "fea" else {"metrics": artifact["metrics"]})}
            modules = json.loads(original['input'])['command'].get('_module_execution')
            if modules:
                if artifact.get('module_execution') != modules:
                    raise ValueError('module artifact does not match its admitted execution')
                result['module_rebuild'] = {key:modules[key] for key in ('rebuilt','reused')}
                result['module_mesh_reused'] = artifact.get('module_mesh_reused',[])
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job,)).fetchone()
            if row["state"] not in ("running", "cancelling"):
                raise Conflict("job is not running")
            if row["state"] == "cancelling":
                state, result = "cancelled", None
            adopted = None
            if state == "succeeded":
                current = self._revision(db, row["project"])
                modules=json.loads(row['input'])['command'].get('_module_execution')
                if modules:
                    from .code_modules import eligible
                    sources={r['id']:json.loads(r['payload']) for r in db.execute('SELECT id,payload FROM sources WHERE project=?',(row['project'],))}
                    if any(not eligible(sources,key,current) for key in modules['source_ids']):
                        state,error,result='failed','module source was forgotten or disabled before adoption',None
                if row["kind"] == "cad" and current["head_revision_id"] == row["revision"]:
                    if state=='succeeded':
                        document = current["document"]
                        document["geometry"] = result["artifact_id"]
                        adopted = self._commit(db, row["project"], row["revision"], document)["revision_id"]
            db.execute("UPDATE jobs SET state=?,result=?,error=?,adopted_revision=?,updated=? WHERE id=?",
                       (state, packed(result) if result else None, error, adopted, time.time(), job))
            self.event(db, job, state, error or "")
