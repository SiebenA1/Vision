"""Offline evidence for the Harness proposal; no model calls or project writes.

Run from the repository root with .python313/python.exe.
The synchronous-step probe is a baseline diagnostic, not the current async model
path. Async lifecycle regressions live in tests/test_model_io_v2.py.
"""
import io
import json
from pathlib import Path
import statistics
import sys
import threading
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.vision import provider
from backend.vision.storage import packed
from backend.vision.task_tools import tool_schemas
from backend.vision.tasks import Tasks


def scheduler_probe():
    entered, release, second, stop = (threading.Event() for _ in range(4))

    class Database:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, *args):
            return [('slow-model-task',), ('ready-local-task',)]

    def step(task):
        if task == 'slow-model-task':
            entered.set()
            if not release.wait(5):
                raise RuntimeError('probe release timed out')
        else:
            second.set()
            stop.set()

    runner = SimpleNamespace(workspace=SimpleNamespace(db=Database), stop=stop, step=step,
                             reconcile_requests=lambda: None, schedule_cursor=0)
    worker = threading.Thread(target=Tasks.loop, args=(runner,))
    worker.start()
    try:
        assert entered.wait(3), 'scheduler did not enter first task'
        blocked = not second.wait(.15)
    finally:
        release.set()
        worker.join(5)
        stop.set()
    assert not worker.is_alive(), 'probe worker leaked'
    assert blocked and second.is_set(), 'synchronous step diagnostic changed'
    return {'actual_method': 'Tasks.loop', 'step_body': 'event-controlled fake model wait',
            'second_task_blocked_during_first_wait': blocked,
            'second_task_proceeded_after_release': second.is_set(), 'observation_window_ms': 150,
            'meaning': 'Blocking synchronous step diagnostic; production model requests now use a separate I/O service.'}


def schema_probe():
    timings = []
    for _ in range(40):
        started = time.perf_counter()
        schemas = tool_schemas()
        timings.append((time.perf_counter() - started) * 1000)
    return {'iterations': len(timings), 'tools': len(schemas),
            'all_schema_characters': len(packed(schemas)),
            'system_base_characters': len(provider.SYSTEM),
            'schema_generation_p50_ms': round(statistics.median(timings), 3),
            'schema_generation_max_ms': round(max(timings), 3),
            'meaning': 'All registered schemas, not a representative filtered request or provider token count.'}


def historical_evidence():
    data = json.loads((ROOT / 'docs/modeling-latency-audit.json').read_text(encoding='utf-8'))
    return [{'task_id': task['task_id'], 'recorded_model_seconds': task['timed_model_seconds'],
             'recorded_cad_queue_and_execution_seconds': round(sum(j['queue_and_execution_seconds'] for j in task['cad_jobs']), 3),
             'meaning': 'Historical recorded intervals; not current end-to-end wall time or an A/B benchmark.'}
            for task in data['tasks']]


def regression_probe():
    sys.path.insert(0, str(ROOT / 'tests'))
    names = ['test_context_efficiency_v2', 'test_provider_response_v2',
             'test_agent_orchestration_v2', 'test_post_build_verification_v2',
             'test_tasks_v2', 'test_model_tasks_v2', 'test_modeling_recovery_v2',
             'test_context_memory_v2', 'test_fast_iteration_v2', 'test_api_lookup_v2',
             'test_retrieval_focus_v2', 'test_analysis_context_v2']
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(name) for name in names)
    stream = io.StringIO()
    started = time.perf_counter()
    result = unittest.TextTestRunner(stream=stream).run(suite)
    return {'modules': names, 'tests': result.testsRun, 'failures': len(result.failures),
            'errors': len(result.errors), 'skipped': len(result.skipped),
            'seconds': round(time.perf_counter() - started, 3),
            'problems': [{'test': str(test), 'traceback': detail} for test, detail in result.failures + result.errors],
            'skip_reasons': [{'test': str(test), 'reason': reason} for test, reason in result.skipped]}


if __name__ == '__main__':
    evidence = {'scope': 'Current working tree; offline probes use no user workspace data.',
                'scheduler': scheduler_probe(), 'schemas': schema_probe(),
                'historical_intervals': historical_evidence()}
    if '--tests' in sys.argv:
        evidence['regression'] = regression_probe()
    print(json.dumps(evidence, ensure_ascii=True, indent=2))
    if '--tests' in sys.argv:
        sys.exit(bool(evidence['regression']['failures'] or evidence['regression']['errors']))
