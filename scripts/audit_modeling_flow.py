"""Run offline regressions for the repaired modeling execution/context flow.

The original before-fix observations remain in docs/modeling-flow-probes.json.
No remote model or existing engineering workspace is used.
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    with patch.dict('os.environ', VISION_MEMORY_SEMANTIC='0'):
        suite = unittest.TestSuite(unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern=pattern) for pattern in
            ('test_modeling_recovery_v2.py', 'test_modeling_acceptance_v2.py', 'test_retrieval_focus_v2.py',
             'test_agent_orchestration_v2.py', 'test_native_thread_v2.py', 'test_context_efficiency_v2.py', 'test_fast_iteration_v2.py',
             'test_post_build_verification_v2.py', 'test_script_channel_v2.py', 'test_code_modules_v2.py'))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
