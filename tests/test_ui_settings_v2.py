"""Desktop preferences are durable workspace data, separate from project revisions."""
import tempfile
import unittest
from fastapi.testclient import TestClient
from backend.vision.api import create_app


class UISettingsTest(unittest.TestCase):
    def test_defaults_persistence_validation_and_idempotency(self):
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(folder, run_jobs=False)) as client:
                self.assertEqual(client.get('/api/v2/ui-settings').json(), {'theme':'system','sidebar_collapsed':False,'chat_width':380})
                request = {'command_id':'appearance','idempotency_key':'appearance','theme':'dark','sidebar_collapsed':True,'chat_width':460}
                saved = client.post('/api/v2/ui-settings', json=request)
                self.assertEqual(saved.status_code, 200, saved.text)
                self.assertEqual(client.post('/api/v2/ui-settings', json=request).json(), saved.json())
                self.assertEqual(client.post('/api/v2/ui-settings', json={**request,'theme':'light'}).status_code, 409)
                self.assertEqual(client.post('/api/v2/ui-settings', json={**request,'command_id':'bad','idempotency_key':'bad','chat_width':2000}).status_code, 422)
                self.assertEqual(client.post('/api/v2/ui-settings', json={**request,'command_id':'extra','idempotency_key':'extra','api_key':'not-a-supported-field'}).status_code, 422)
                info = client.get('/api/v2/workspace-info').json()
                self.assertEqual(info['database'], 'SQLite')
                self.assertEqual(info['counts']['projects'], 0)
            with TestClient(create_app(folder, run_jobs=False)) as client:
                self.assertEqual(client.get('/api/v2/ui-settings').json(), {'theme':'dark','sidebar_collapsed':True,'chat_width':460})


if __name__ == '__main__':
    unittest.main()
