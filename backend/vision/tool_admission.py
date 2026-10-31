"""Immutable model-facing selection; full typed command validation stays in prepare."""
from dataclasses import dataclass
import hashlib
import json

from .storage import packed


@dataclass(frozen=True)
class ToolAdmission:
    encoded: str

    @classmethod
    def capture(cls, schemas):
        names = [item['function']['name'] for item in schemas]
        if len(names) != len(set(names)):
            raise ValueError('duplicate admitted tool')
        return cls(packed(schemas))

    @property
    def sha256(self):
        return hashlib.sha256(self.encoded.encode()).hexdigest()

    def contains(self, name):
        return any(item['function']['name'] == name for item in json.loads(self.encoded))

    def validate_surface(self, item):
        """Check stage-specific fields/requirements before server-side expansion.

        Pydantic prepare then validates types, nested values and command semantics.
        This deliberately does not implement another general JSON Schema validator.
        """
        definition = next((entry['function'] for entry in json.loads(self.encoded)
                           if entry['function']['name'] == item['tool']), None)
        if definition is None:
            raise ValueError('tool was not admitted for this step')
        arguments = item['arguments']
        if not isinstance(arguments, dict):
            raise ValueError('tool arguments must be an object')
        schema = definition['parameters']
        extra = set(arguments) - set(schema.get('properties', {}))
        missing = set(schema.get('required', [])) - set(arguments)
        if extra or missing:
            # Field names only; do not echo potentially sensitive argument values.
            raise ValueError('admitted tool fields invalid: ' + packed({'extra': sorted(extra), 'missing': sorted(missing)}))
