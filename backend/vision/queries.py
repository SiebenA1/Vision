"""One bounded interactive lane, independent of long-running numerical jobs."""
import json
import hashlib
import copy
import os
from pathlib import Path
import subprocess
import tempfile
import threading

from .processes import ProcessTree
from .storage import packed

ROOT = Path(__file__).resolve().parents[2]


def api_identity():
    from .runtime import profile
    value = {"runtime": profile("cad"), "query_worker": hashlib.sha256(Path(__file__).with_name("query_worker.py").read_bytes()).hexdigest()}
    return hashlib.sha256(packed(value).encode()).hexdigest()


class QueryUnavailable(Exception):
    def __init__(self, detail, status=503):
        self.detail, self.status = detail, status


class Queries:
    def __init__(self, workspace, timeout=15):
        self.workspace, self.timeout = workspace, timeout
        self.slot = threading.Lock()
        self.guard = threading.Lock()
        self.active = None
        self.closed = False
        self.api_cache = {}
        self.api_overviews = {}

    def close(self):
        with self.guard:
            self.closed = True
            if self.active:
                self.active.terminate()

    def inspect(self, project, request):
        revision = self.workspace.revision(project, request["revision_id"])
        if revision["document"]["geometry"] != request["artifact_id"]:
            raise ValueError("query artifact does not belong to the specified project revision")
        manifest = self.workspace.artifacts.manifest(request["artifact_id"])
        selected = request.get('selection', [])
        if request.get('metrics_only') and selected and not request.get('pick'):
            bodies = {body['id']:body for body in manifest['bodies']}
            if all(key in bodies for key in selected):
                from .modeling import body_metrics
                return {'selection':selected, 'metrics':[body_metrics(bodies[key]) for key in selected],
                        'candidates':[], 'candidate_count':0, 'is_pick':False,
                        'visual':{'lines':[], 'truncated':False}, 'method':'artifact-body-metrics/1',
                        'revision_id':request['revision_id'], 'artifact_id':request['artifact_id']}
        files = [str(self.workspace.artifacts.file(request["artifact_id"], f"body-{index}.brep")) for index in range(len(manifest["bodies"]))]
        output = self.run({**request, "source_breps": files})
        return {**output, "is_pick": bool(request.get("pick")), "revision_id": request["revision_id"], "artifact_id": request["artifact_id"]}

    def native_api(self, request):
        runtime = api_identity()
        lookups = request.get("queries") or [request]
        normalized = [{"query": " ".join(sorted(set(item.get("query", "").lower().replace("|", " ").replace(",", " ").split()))),
                       "offset": item.get("offset", 0), "limit": item.get("limit", 4)} for item in lookups]
        keys = [packed({"runtime": runtime, "lookup": item}) for item in normalized]
        resolved = {key: self.api_cache[key] for key in keys if key in self.api_cache}
        missing = {key: item for key, item in zip(keys, normalized) if key not in self.api_cache}
        hits = len(keys) - sum(key in missing for key in keys)
        if missing:
            output = self.run({"operation": "capabilities", "queries": list(missing.values())})
            if output.get('capability_index'):
                self.api_overviews = {runtime: output['capability_index']}
            values = output.get("lookups") or [output]
            if len(values) != len(missing):
                raise ValueError("CAD documentation query returned incomplete batch")
            for key, value in zip(missing, values):
                if len(self.api_cache) >= 64:
                    self.api_cache.pop(next(iter(self.api_cache)))
                self.api_cache[key] = {"version": output.get("version"), **value}
                resolved[key] = self.api_cache[key]
        values = [copy.deepcopy(resolved[key]) for key in keys]
        overview = self.api_overviews.get(runtime)
        receipt_budget = 14000 - (len(packed(overview)) if overview else 0)
        # Hits from separate batches may contain longer pages. Bound the merged
        # receipt too, while preserving exact signatures and explicit pagination.
        for length in (1600, 500, 200, 0):
            if len(packed(values)) <= receipt_budget:
                break
            for value in values:
                for entry in value.get("entries", []):
                    document = entry.get("documentation", "")
                    entry["documentation"] = document[:length]
                    entry["documentation_truncated"] = entry.get("documentation_truncated", False) or len(document) > length
        while len(packed(values)) > receipt_budget:
            largest = max(values, key=lambda value: len(value.get("entries", [])))
            if len(largest.get("entries", [])) <= 1:
                raise ValueError("CAD signatures exceed bounded documentation receipt")
            largest["entries"].pop()
        for value in values:
            value["next_offset"] = value.get("offset", 0) + len(value.get("entries", []))
            value["has_more"] = value["next_offset"] < value.get("total_matches", 0)
        base = {"version": values[0].get("version"), "runtime_id": runtime, "cache_hit": not missing, "cached_lookups": hits}
        if overview:
            base['capability_index'] = copy.deepcopy(overview)
        return {**base, "lookups": values} if request.get("queries") else {**base, **values[0]}

    def run(self, request):
        if not self.slot.acquire(blocking=False):
            raise QueryUnavailable("原生选择查询正在进行，请稍后重试。")
        try:
            with tempfile.TemporaryDirectory(prefix="query-", dir=self.workspace.root) as temporary:
                folder = Path(temporary)
                source, result = folder / "request.json", folder / "response.json"
                source.write_text(packed(request), encoding="utf-8")
                env = {key: value for key, value in os.environ.items() if key not in ("PYTHONPATH", "PYTHONHOME", "DEEPSEEK_API_KEY")}
                with self.guard:
                    if self.closed:
                        raise QueryUnavailable("工程服务正在停止。")
                    process = subprocess.Popen([str(ROOT / ".python312/python.exe"), "-I", "-X", "utf8",
                        str(Path(__file__).with_name("query_worker.py")), str(source), str(result)],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        env=env, text=True, start_new_session=os.name != "nt",
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                    tree = ProcessTree(process, memory_limit_mib=1024 if os.name == "nt" else None)
                    self.active = tree
                try:
                    try:
                        process.communicate("start\n", timeout=self.timeout)
                    except subprocess.TimeoutExpired:
                        raise QueryUnavailable("原生选择查询超时；工程版本未改变。", 504)
                    if process.returncode or not result.is_file() or result.stat().st_size > 2 * 1024 * 1024:
                        raise QueryUnavailable("原生选择查询未完成；请重试或使用对象列表。")
                    output = json.loads(result.read_text(encoding="utf-8"))
                    if "error" in output:
                        raise ValueError(output["error"])
                    return output
                finally:
                    with self.guard:
                        if process.poll() is None:
                            tree.terminate()
                        process.wait(timeout=10)
                        tree.close()
                        self.active = None
        finally:
            self.slot.release()
