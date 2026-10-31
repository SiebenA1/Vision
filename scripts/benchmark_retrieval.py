"""Disposable lexical-only warm-query benchmark; no remote calls or user data."""
import argparse
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.vision.storage import Workspace, packed
from backend.vision.retrieval import retrieve


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=int, default=10000)
    parser.add_argument('--iterations', type=int, default=12)
    args = parser.parse_args()
    if not 1 <= args.sources <= 100000 or not 1 <= args.iterations <= 10000:
        parser.error('sources must be 1–100000; iterations must be 1–10000')
    os.environ['VISION_MEMORY_SEMANTIC'] = '0'
    with tempfile.TemporaryDirectory(prefix='vision-retrieval-bench-') as folder:
        workspace = Workspace(folder)
        project = workspace.create({'command_id': 'benchmark', 'idempotency_key': 'benchmark', 'name': 'Disposable benchmark'})['project_id']
        with workspace.db() as db:
            db.executemany('INSERT INTO sources VALUES(?,?,?,?)', [(f'{i:032x}', project,
                packed({'origin': 'user_task_input', 'text': ('needle' if i == args.sources - 1 else 'other') + ' ' + 'x' * 200}),
                float(i)) for i in range(args.sources)])
        retrieve(workspace, project, 'needle')  # Cold index preparation is outside warm timings.
        timings = []
        for _ in range(args.iterations):
            started = time.perf_counter()
            found, metadata = retrieve(workspace, project, 'needle')
            timings.append((time.perf_counter() - started) * 1000)
            assert metadata['result_cache_hit'] and len(found) == 1
        print(json.dumps({'sources': args.sources, 'iterations': args.iterations,
            'warm_p50_ms': round(statistics.median(timings), 3), 'warm_max_ms': round(max(timings), 3),
            'method': 'Lexical-only unchanged warm query; no remote model, end-to-end or p95 claim.'}, indent=2))


if __name__ == '__main__':
    main()
