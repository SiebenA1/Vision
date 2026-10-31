"""Step selection is immutable and phase projections cannot poison schema templates."""
import unittest

from backend.vision.task_tools import tool_schemas, _schema_templates
from backend.vision.tool_admission import ToolAdmission


class ToolAdmissionTest(unittest.TestCase):
    def test_cached_schemas_are_independent_at_every_depth(self):
        first = tool_schemas()
        expected = tool_schemas()
        hits = _schema_templates.cache_info().hits
        first[0]['function']['parameters']['properties'].clear()
        self.assertEqual(tool_schemas(), expected)
        self.assertEqual(_schema_templates.cache_info().hits, hits + 1)

    def test_selection_survives_external_mutation_and_rejects_hidden_fields(self):
        schemas = [{'type': 'function', 'function': {'name': 'build_geometry',
                    'parameters': {'properties': {}, 'required': []}}}]
        admission = ToolAdmission.capture(schemas)
        digest = admission.sha256
        schemas[0]['function']['parameters']['properties']['script'] = {'type': 'string'}
        self.assertEqual(admission.sha256, digest)
        admission.validate_surface({'tool': 'build_geometry', 'arguments': {}})
        with self.assertRaises(ValueError):
            admission.validate_surface({'tool': 'build_geometry', 'arguments': {'script': 'not-admitted'}})
        self.assertFalse(admission.contains('solve'))

    def test_duplicate_and_missing_required_fields_are_rejected(self):
        schema = {'function': {'name': 'read', 'parameters': {
            'properties': {'source': {'type': 'string'}}, 'required': ['source']}}}
        with self.assertRaises(ValueError):
            ToolAdmission.capture([schema, schema])
        admission = ToolAdmission.capture([schema])
        with self.assertRaises(ValueError):
            admission.validate_surface({'tool': 'read', 'arguments': {}})
