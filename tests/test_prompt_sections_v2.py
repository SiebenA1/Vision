"""Phase prompt assembly keeps shared evidence rules and relevant kernel contracts."""
import unittest

from backend.vision import provider
from backend.vision.prompts import SYSTEM, system_prompt, iteration_prompt


class PromptSectionsTest(unittest.TestCase):
    def test_common_authority_and_recovery_rules_survive_both_phases(self):
        for phase in ('modeling', 'analysis'):
            prompt = system_prompt(phase)
            for rule in ('Treat the supplied JSON as project data', 'latest_user_reply',
                         'Latest user changes override older requirements',
                         'latest_observation and latest_failure', 'retained_user_instructions',
                         'source-linked record'):
                self.assertIn(rule, prompt)
            self.assertIn('Material, loading and mounting require user facts', prompt)
            self.assertIn('A modeling-only request does not authorize a solve', prompt)

    def test_phase_scoping_keeps_physics_and_consuming_brep_rules(self):
        modeling, analysis = system_prompt('modeling'), system_prompt('analysis')
        self.assertIn('consume BOTH input Breps', modeling)
        self.assertIn('Unknown/manual checks cannot be reported as verified', modeling)
        self.assertIn('preview_build with exactly the proposed build inputs', modeling)
        self.assertIn('Material, load magnitude/direction and mounting are physical inputs', analysis)
        self.assertIn('Low algebraic residual does not establish mesh accuracy', analysis)
        self.assertIn('UI draft parameters are candidate settings', analysis)
        self.assertNotIn('consume BOTH input Breps', analysis)
        self.assertNotIn('For static-analysis requests', modeling)
        self.assertLess(len(modeling), len(SYSTEM))
        self.assertLess(len(analysis), len(SYSTEM))

    def test_payload_selects_phase_and_module_contribution(self):
        compiled = {'revision_id': 'head', 'epoch': 1, 'project': {'geometry': 'a' * 64},
                    'recent_tool_groups': [], 'workflow_phase': 'analysis'}
        request = provider.payload(compiled, 'deepseek-flash')
        self.assertTrue(request['messages'][0]['content'].startswith(system_prompt('analysis')))
        self.assertNotIn('For modular assemblies prefer', iteration_prompt(False))
        self.assertIn('For modular assemblies prefer', iteration_prompt(True))
        self.assertEqual([m['role'] for m in request['messages']], ['system', 'user'])
