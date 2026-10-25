"""Bounded real-HTTP smoke in a disposable workspace; no remote model requests."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
from backend.vision.api import create_app
from backend.vision import conversation
from test_modeling_recovery_v2 import command, response


def main():
    with tempfile.TemporaryDirectory(prefix='vision-http-', dir=ROOT / 'tests') as folder:
        app = create_app(folder, run_jobs=False)
        project = app.state.workspace.create(command(name='HTTP completion smoke'))
        with patch('backend.vision.provider.api_key', return_value='offline'):
            sent = conversation.send(app.state.tasks, project['project_id'], command(expected_head=project['revision_id'],
                text='仅总结当前状态', expected_task=None, expected_epoch=None, artifact_id=None, selection=[]))
        app.state.tasks.step(sent['task_id'])
        with patch('backend.vision.provider.complete', return_value=response('finish', dict(summary='尚无模型', outcome='answer'))):
            app.state.tasks.step(sent['task_id'])
        app.state.queries.close()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        code = ('import sys;sys.path.insert(0,sys.argv[1]);from backend.vision.api import create_app;import uvicorn;'
                'uvicorn.run(create_app(sys.argv[2],run_jobs=False),host="127.0.0.1",port=int(sys.argv[3]),log_level="warning")')
        log_path = Path(folder) / 'http-server.log'
        with log_path.open('w', encoding='utf-8') as log:
            child = subprocess.Popen([sys.executable, '-I', '-X', 'utf8', '-c', code, str(ROOT), folder, str(port)],
                stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
            try:
                base, ready, last = f'http://127.0.0.1:{port}', False, ''
                deadline = time.monotonic() + 15
                with httpx.Client(timeout=2, trust_env=False) as client:
                    while time.monotonic() < deadline:
                        if child.poll() is not None:
                            raise RuntimeError('isolated server exited: ' + log_path.read_text(encoding='utf-8'))
                        try:
                            health = client.get(base + '/api/v2/health')
                            ready, last = health.status_code == 200, f'HTTP {health.status_code}'
                            if ready:
                                break
                        except httpx.HTTPError as error:
                            last = type(error).__name__
                        time.sleep(.1)
                    if not ready:
                        raise RuntimeError('isolated server did not answer health: ' + last + '\n' + log_path.read_text(encoding='utf-8'))
                    result = client.get(base + '/api/v2/projects/' + project['project_id'] + '/conversation')
                    assert result.status_code == 200, result.status_code
                    assert result.json()['messages'][-1]['completion']['status'] == 'not_built'
                    written = client.post(base + '/api/v2/projects', json=command(name='HTTP write smoke'))
                    assert written.status_code == 201, written.status_code
                    report = dict(health=True, conversation_completion_status='not_built', project_create_status=201,
                                  remote_model_calls=0, workspace='disposable')
                    (ROOT / 'docs/modeling-batch-02-http-smoke.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
                    print('PASS: real HTTP health, completion JSON, and project write; remote model calls=0')
            finally:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)


if __name__ == '__main__':
    main()
