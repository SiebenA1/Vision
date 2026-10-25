"""Incomplete model replies are metered, recoverable, and never executable."""
import unittest

from backend.vision import provider


def reply(finish):
    return {'id': 'response-1', 'model': 'deepseek-flash',
            'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15},
            'choices': [{'finish_reason': finish, 'message': {'content': 'partial reply'}}]}


class IncompleteResponseTest(unittest.TestCase):
    def test_thinking_tool_choice_rejection_is_actionable_and_redacted(self):
        import json
        body = json.dumps({'error':{'message':'tool_choice required is not supported in thinking mode; secret-key project-text'}}).encode()
        error = str(provider.http_error(400, body))
        self.assertIn('tool_choice=auto', error)
        self.assertNotIn('secret-key', error)
        self.assertNotIn('project-text', error)
        self.assertNotIn('凭据', error)

    def test_unknown_provider_errors_do_not_echo_arbitrary_data(self):
        for body in (b'secret-key', b'{"error":null}', b'[]', b'{"error":{"message":123}}'):
            self.assertNotIn('secret-key', str(provider.http_error(400, body)))

    def test_truncated_and_plain_text_replies_preserve_usage(self):
        for finish in ('length', 'stop'):
            with self.subTest(finish=finish), self.assertRaises(provider.IncompleteToolResponse) as caught:
                provider.parse(reply(finish), 'deepseek-flash')
            self.assertEqual(caught.exception.receipt['usage']['total_tokens'], 15)
            self.assertEqual(caught.exception.receipt['finish_reason'], finish)
            self.assertEqual(caught.exception.receipt['call_count'], 0)

    def test_untrusted_usage_is_not_accepted_for_recovery(self):
        value = reply('length')
        value['usage']['total_tokens'] = 0
        with self.assertRaises(ValueError) as caught:
            provider.parse(value, 'deepseek-flash')
        self.assertNotIsInstance(caught.exception, provider.IncompleteToolResponse)

    def test_complete_call_still_requires_valid_json(self):
        value = reply('tool_calls')
        value['choices'][0]['message']['tool_calls'] = [{'id': 'call-1', 'type': 'function',
            'function': {'name': 'finish', 'arguments': '{"summary":'}}]
        with self.assertRaises(ValueError):
            provider.parse(value, 'deepseek-flash')


if __name__ == '__main__':
    unittest.main()
