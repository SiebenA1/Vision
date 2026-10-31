"""Local FastEmbed inference, durable SQLite vectors and a rebuildable Qdrant index."""
import hashlib
import copy
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import uuid

from server.agent_memory import search_tokens
from .engineering_memory import context_eligible, available, lineage
from .storage import packed

EMBEDDING = "BAAI/bge-small-zh-v1.5"
RERANKER = "BAAI/bge-reranker-v2-m3-int8"
CACHE = Path(__file__).resolve().parents[2] / ".memory-models"
MODEL_LOCK = threading.RLock()
_models = {}


def compact_text(text, limit):
    """Keep both the request opening and its latest/tail qualification."""
    return text if len(text) <= limit else text[:limit // 2] + '…' + text[-(limit - limit // 2 - 1):]


def deduplicate_query(query):
    seen, kept = set(), []
    for clause in re.split(r'(?<=[。！？!?；;\n])', query):
        key = clause.strip()
        if key and key not in seen:
            seen.add(key)
            kept.append(clause)
    return ''.join(kept)


def diverse_ranking(ranking, candidates, sources=24, per_source=2):
    counts, result = {}, []
    for key in ranking:
        if key not in candidates:
            continue
        source = candidates[key]['source']
        if source not in counts and len(counts) >= sources:
            continue
        if counts.get(source, 0) >= per_source:
            continue
        counts[source] = counts.get(source, 0) + 1
        result.append(key)
    return result


def embedding_key():
    ready = CACHE / "ready.json"
    if not ready.is_file():
        return EMBEDDING
    return EMBEDDING + ":" + json.loads(ready.read_text(encoding="utf-8")).get("embedding_sha256", "unversioned")


def models():
    # Never make a model-hub request while handling project text. Setup is explicit.
    with MODEL_LOCK:
        if not _models:
            from fastembed import TextEmbedding
            from fastembed.rerank.cross_encoder import TextCrossEncoder
            kwargs = {"cache_dir": str(CACHE), "local_files_only": True, "threads": 2,
                      "providers": ["CPUExecutionProvider"]}
            embedding = TextEmbedding(model_name=EMBEDDING, specific_model_path=str(CACHE / "embedding"), **kwargs)
            reranker = TextCrossEncoder(model_name=RERANKER, specific_model_path=str(CACHE / "reranker"), **kwargs)
            _models.update(embedding=embedding, reranker=reranker)
        return _models["embedding"], _models["reranker"]


def chunks(text):
    # 320 characters fit the Chinese encoder's 512-token window, with overlap.
    return [(offset, text[offset:offset + 320]) for offset in range(0, len(text), 272) if text[offset:offset + 320].strip()]


def sync_lexical(workspace):
    """Drain a transactionally enqueued dirty set; unchanged sources are not rewritten."""
    with workspace.db() as db:
        if not db.execute("SELECT 1 FROM retrieval_state WHERE key='archive_backfill'").fetchone():
            from .engineering_memory import archive_receipt
            for row in db.execute("SELECT t.*,a.project,a.source FROM agent_turns t JOIN agent_tasks a ON a.id=t.task WHERE t.state='succeeded'").fetchall():
                response, receipt = json.loads(row["response"]), json.loads(row["receipt"])
                tool = response.get("tool")
                if tool in ("build_geometry", "configure_study", "solve", "assessment", "inspect_geometry"):
                    source = db.execute("SELECT id FROM sources WHERE project=? AND json_extract(payload,'$.task_id')=? AND json_extract(payload,'$.epoch')=? ORDER BY created LIMIT 1", (row["project"], row["task"], row["epoch"])).fetchone()
                    if source:
                        archive_receipt(db, {"id": row["task"], "project": row["project"], "source": source[0]}, row["id"], tool, receipt, row["revision"])
            db.execute("INSERT INTO retrieval_state VALUES('archive_backfill','1')")
        for row in db.execute("SELECT * FROM retrieval_queue").fetchall():
            source, project = row["id"], row["project"]
            stored = db.execute("SELECT payload FROM sources WHERE id=? AND project=?", (source, project)).fetchone()
            db.execute("DELETE FROM retrieval_fts WHERE id IN (SELECT id FROM retrieval_chunks WHERE source=?)", (source,))
            db.execute("DELETE FROM retrieval_chunks WHERE source=?", (source,))
            db.execute("DELETE FROM source_fts WHERE id=? AND project=?", (source, project))
            value = json.loads(stored[0]) if stored else {}
            text = value.get("text", "")
            if isinstance(text, str) and value.get("origin") != "deleted" and value.get("status", "active") == "active":
                for offset, part in chunks(text):
                    digest = hashlib.sha256(part.encode()).hexdigest()
                    chunk = uuid.uuid5(uuid.NAMESPACE_URL, project + ":" + source + ":" + str(offset) + ":" + digest).hex
                    db.execute("INSERT INTO retrieval_chunks VALUES(?,?,?,?,?,?)", (chunk, source, project, part, digest, offset))
                    db.execute("INSERT INTO retrieval_fts VALUES(?,?,?)", (chunk, project, " ".join(search_tokens(part))))
            db.execute("DELETE FROM retrieval_queue WHERE id=?", (source,))


class SemanticIndex:
    def __init__(self):
        from qdrant_client import QdrantClient, models as qm
        self.client = QdrantClient(location=":memory:")
        self.qm = qm
        self.client.create_collection("memory", vectors_config=qm.VectorParams(size=512, distance=qm.Distance.COSINE))
        self.loaded = {}
        self.model_key = None

    def rank(self, workspace, project, candidates, query):
        embedding, reranker = models()
        model_key = embedding_key()
        if self.model_key != model_key:
            self.loaded.clear()
            self.model_key = model_key
        qm = self.qm
        with workspace.db() as db:
            saved = {row["id"]: json.loads(row["vector"]) for row in db.execute(
                "SELECT v.id,v.vector FROM retrieval_vectors v JOIN retrieval_chunks c ON c.id=v.id WHERE c.project=? AND v.model=?", (project, model_key))}
        missing = [item for key, item in candidates.items() if key not in saved]
        if missing:
            vectors = list(embedding.passage_embed([item["text"] for item in missing], batch_size=16))
            with workspace.db() as db:
                for item, vector in zip(missing, vectors, strict=True):
                    # A source may have been forgotten while inference was running.
                    if db.execute("SELECT 1 FROM retrieval_chunks WHERE id=? AND digest=?", (item["id"], item["digest"])).fetchone():
                        saved[item["id"]] = vector.tolist()
                        db.execute("INSERT OR REPLACE INTO retrieval_vectors VALUES(?,?,?)", (item["id"], model_key, packed(vector.tolist())))
        wanted = set(candidates) & set(saved)
        stale = set(self.loaded.get(project, ())) - wanted
        if stale:
            self.client.delete("memory", points_selector=qm.PointIdsList(points=list(stale)))
        new = wanted - set(self.loaded.get(project, ()))
        if new:
            self.client.upsert("memory", points=[qm.PointStruct(id=key, vector=saved[key], payload={"project": project,
                                                                                                 'source': candidates[key]['source']}) for key in new])
        self.loaded[project] = wanted
        if not wanted:
            return [], reranker
        query_vector = next(embedding.query_embed(compact_text(query, 320))).tolist()
        groups = self.client.query_points_groups("memory", query=query_vector, group_by='source', group_size=2,
            query_filter=qm.Filter(must=[qm.FieldCondition(key="project", match=qm.MatchValue(value=project)), qm.HasIdCondition(has_id=list(wanted))]), limit=24).groups
        points = sorted((point for group in groups for point in group.hits), key=lambda point: (-point.score, str(point.id)))
        return [uuid.UUID(str(point.id)).hex for point in points], reranker


def status():
    return {"embedding": EMBEDDING, "reranker": RERANKER, "local_only": True,
            "models_ready": bool(_models), "cache_present": (CACHE / "ready.json").is_file(),
            "vector_database": "Qdrant local; SQLite persists rebuildable vectors"}


def clear_project_cache(workspace, project):
    # Older live workspaces may predate eager lock initialization. Retrieval
    # creates the lock before publishing any cache, so there is nothing to clear.
    if not hasattr(workspace, "retrieval_lock"):
        return
    with workspace.retrieval_lock:
        if hasattr(workspace, "retrieval_results"):
            workspace.retrieval_results.clear()
        index = getattr(workspace, "semantic_index", None)
        if index:
            points = index.loaded.pop(project, set())
            if points:
                index.client.delete("memory", points_selector=index.qm.PointIdsList(points=list(points)))


def retrieve(workspace, project, query, limit=6, revision=None):
    if not isinstance(query, str) or not 1 <= len(query) <= 2000:
        raise ValueError("source query must contain 1–2000 characters")
    if not 1 <= limit <= 24:
        raise ValueError("retrieval limit must be 1–24")
    original_query_characters = len(query)
    query = deduplicate_query(query) or query
    started = time.monotonic()
    # One workspace lock protects derived index publication, not project writes.
    if not hasattr(workspace, "retrieval_lock"):
        workspace.retrieval_lock = threading.RLock()
    with workspace.retrieval_lock:
        sync_lexical(workspace)
        with workspace.db() as db:
            current = workspace._revision(db, project, revision)
            generation = db.execute('SELECT value FROM retrieval_state WHERE key=?', ('source_generation:' + project,)).fetchone()
            cache_key = hashlib.sha256(packed({'project': project, 'revision': current['revision_id'],
                'source_generation': generation[0] if generation else '0',
                'query': query, 'limit': limit, 'semantic': os.environ.get('VISION_MEMORY_SEMANTIC', '1'),
                'models': (CACHE / 'ready.json').stat().st_mtime_ns if (CACHE / 'ready.json').is_file() else None}).encode()).hexdigest()
            cache = getattr(workspace, 'retrieval_results', None)
            if cache is None:
                workspace.retrieval_results = cache = {}
            if cache_key in cache:
                result, metadata = copy.deepcopy(cache[cache_key])
                return result, {**metadata, 'result_cache_hit': True, 'original_query_characters': original_query_characters,
                                'duration_ms': round((time.monotonic() - started) * 1000, 2)}
            rows = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=? ORDER BY created,id", (project,))}
            availability = {}
            valid = {key for key, value in rows.items() if available(rows, key, availability)
                     and context_eligible(rows, key, current)}
            candidates = {row["id"]: dict(row) for row in db.execute("SELECT * FROM retrieval_chunks WHERE project=?", (project,)) if row["source"] in valid}
            all_tokens = search_tokens(query)
            tokens = list(dict.fromkeys(all_tokens[:24] + all_tokens[-24:]))
            expression = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
            matches = db.execute("SELECT f.id FROM retrieval_fts f WHERE retrieval_fts MATCH ? AND f.project=? ORDER BY bm25(retrieval_fts)", (expression, project)) if expression else []
            # Filter authority and source diversity before the top-k cutoff.
            lexical, counts = [], {}
            for row in matches:
                item = candidates.get(row[0])
                if not item or counts.get(item['source'], 0) >= 2:
                    continue
                counts[item['source']] = counts.get(item['source'], 0) + 1
                lexical.append(row[0])
                if len(counts) >= 24:
                    break
        dense, reranker, degraded = [], None, None
        try:
            if os.environ.get("VISION_MEMORY_SEMANTIC", "1") == "0":
                raise RuntimeError("semantic_disabled")
            if not (CACHE / "ready.json").is_file():
                raise RuntimeError("models_not_installed")
            if not hasattr(workspace, "semantic_index"):
                workspace.semantic_index = SemanticIndex()
            dense, reranker = workspace.semantic_index.rank(workspace, project, candidates, query)
        except (ImportError, OSError, ValueError, RuntimeError) as error:
            degraded = type(error).__name__ + ": " + (str(error) if str(error) in ("models_not_installed", "semantic_disabled") else "local_semantic_unavailable")
        # Exact identifiers/numeric strings supplement semantics; never coerce units.
        exact_terms = re.findall(r"body-\d+(?:/(?:face|edge)-\d+)?|\b\d+(?:\.\d+)?\s*(?:mm|MPa|N|kg)\b", query, re.I)
        exact = diverse_ranking((key for key, item in candidates.items() if any(term.lower() in item["text"].lower() for term in exact_terms)), candidates)
        fusion = {}
        for ranking in (lexical, dense, exact):
            for rank, key in enumerate(ranking):
                fusion[key] = fusion.get(key, 0) + 1 / (60 + rank + 1)
        ordered = sorted(fusion, key=lambda key: (-fusion[key], key))
        ranked = diverse_ranking(ordered, candidates, per_source=1)[:24]
        for key in ordered:
            if len(ranked) >= 24:
                break
            if key not in ranked:
                ranked.append(key)
        scores = {}
        if reranker and ranked:
            try:
                values = list(reranker.rerank(query, [candidates[key]["text"] for key in ranked], batch_size=4))
                if len(values) != len(ranked) or not all(math.isfinite(float(value)) for value in values):
                    raise ValueError("invalid rerank scores")
                scores = dict(zip(ranked, map(float, values), strict=True))
                ranked.sort(key=lambda key: (-scores[key], -fusion[key], key))
            except (OSError, RuntimeError, ValueError):
                degraded = "local_rerank_unavailable"
        # Revalidate authority after inference: deletion/correction can race ranking.
        with workspace.db() as db:
            fresh_revision = workspace._revision(db, project, revision)
            fresh = {row["id"]: json.loads(row["payload"]) for row in db.execute("SELECT id,payload FROM sources WHERE project=? ORDER BY created,id", (project,))}
        result, seen, availability = [], set(), {}
        for key in ranked:
            item = candidates[key]
            source = item["source"]
            value = fresh.get(source, {})
            if source in seen or not available(fresh, source, availability) or not context_eligible(fresh, source, fresh_revision) or value != rows[source]:
                continue
            if value.get("scope") == "geometry" and value.get("artifact_id") != fresh_revision["document"].get("geometry"):
                continue
            seen.add(source)
            offset = item["offset"]
            text = value.get("text", "")
            # Expand a little surrounding text; keep exact original provenance.
            start, end = max(0, offset - 160), min(len(text), offset + 800)
            ref = value.get("reference") or {}
            result.append({"source_id": source, "source_ids": lineage(fresh, [source]), "origin": value.get("origin"),
                "text": text[start:end], "offset": start, "truncated": start > 0 or end < len(text),
                "revision_id": value.get("revision_id"), "current_geometry": not ref or ref.get("artifact_id") == current["document"].get("geometry"),
                "current_revision": value.get("revision_id") == current["revision_id"],
                "turn_id": value.get("turn_id"),
                "fusion_score": fusion[key], "rerank_score": scores.get(key),
                "meaning": value.get("meaning", "historical source statement, not verified numerical evidence")})
            if len(result) >= limit:
                break
        metadata = {**status(), "mode": "hybrid_reranked" if scores else "hybrid" if dense else "lexical",
            "degraded_reason": degraded, "candidate_chunks": len(candidates), "lexical_hits": len(lexical),
            "dense_hits": len(dense), "reranked_chunks": len(scores), "returned_sources": len(result),
            'candidate_sources': len({candidates[key]['source'] for key in ranked}),
            'rerank_query_characters': len(query) if scores else 0,
            'original_query_characters': original_query_characters,
            "result_cache_hit":False, "duration_ms": round((time.monotonic() - started) * 1000, 2)}
        if fresh == rows and fresh_revision["revision_id"] == current["revision_id"]:
            if len(cache) >= 16:
                cache.pop(next(iter(cache)))
            cache[cache_key] = copy.deepcopy((result, metadata))
        return result, metadata
