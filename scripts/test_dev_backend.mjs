// Real v2 startup/proxy/lifecycle regression in a disposable workspace; no LLM calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, loadConfigFromFile } from 'vite';

const workspace = await mkdtemp(resolve('tests/tmp-dev-core-'));
delete process.env.VISION_CORE_URL;
process.env.VISION_CORE_PORT = '8120';
process.env.VISION_CORE_WORKSPACE = workspace;
process.env.VISION_MEMORY_SEMANTIC = '0';
const backendUrl = 'http://127.0.0.1:8120';
const frontendUrl = 'http://127.0.0.1:4176';
const create = () => createServer({ server: { host: '127.0.0.1', port: 4176, strictPort: true } });
async function health() {
  try { return await (await fetch(`${backendUrl}/api/v2/health`, { signal: AbortSignal.timeout(1500) })).json(); }
  catch { return null; }
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await delay(100); }
  assert.fail('backend lifecycle timed out');
}
let server, external, wrong;
try {
  assert.equal(await health(), null, 'test port 8120 must be free');
  server = await create(); await server.listen();
  let response = await fetch(`${frontendUrl}/api/v2/health`);
  let data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.api, 'v2');
  assert.equal(data.controller, true);
  response = await fetch(`${frontendUrl}/api/v2/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command_id: 'dev-start', idempotency_key: 'dev-start', name: 'Startup regression' }),
  });
  data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  const projectId = data.project_id;
  assert.equal(data.document.name, 'Startup regression');
  console.log('PASS auto-start -> v2 health proxy -> persistent project write');
  await server.close(); server = null;
  await waitFor(async () => !await health());
  console.log('PASS closing Vite stops its owned core');

  external = spawn('.python313/python.exe', ['-u', '-m', 'backend.vision', '--port', '8120', '--workspace', workspace], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env },
  });
  await waitFor(async () => (await health())?.controller === true);
  server = await create(); await server.listen();
  data = await (await fetch(`${frontendUrl}/api/v2/projects/${projectId}`)).json();
  assert.equal(data.document.name, 'Startup regression');
  await server.close(); server = null;
  assert.equal((await health())?.controller, true, 'Vite must not stop a reused core');
  console.log('PASS existing core reuse, ownership and data persistence');

  process.env.VISION_CORE_URL = backendUrl;
  server = await create(); await server.listen();
  const exited = once(external, 'exit'); external.kill(); await exited; external = null;
  response = await fetch(`${frontendUrl}/api/v2/projects`);
  data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'CORE_BACKEND_UNAVAILABLE');
  assert.ok(data.detail.includes('8120'));
  await server.close(); server = null;
  server = await create(); await server.listen();
  assert.equal(await health(), null, 'explicit VISION_CORE_URL must disable managed startup');
  await server.close(); server = null;
  console.log('PASS external URL disables startup; unavailable core returns JSON 503');

  delete process.env.VISION_CORE_URL;
  wrong = createHttpServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ api: 'v2', schema: 'vision.workspace/4', controller: false })); });
  await new Promise(resolveReady => wrong.listen(8120, '127.0.0.1', resolveReady));
  const config = await loadConfigFromFile({ command: 'serve', mode: 'development' });
  const plugin = config.config.plugins.find(item => item.name === 'vision-core-backend');
  await assert.rejects(() => plugin.configureServer({ httpServer: new EventEmitter(), config: { root: process.cwd(), logger: { info() {} } } }), /inactive controller/);
  console.log('PASS inactive or incompatible service is rejected');
} finally {
  if (server) await server.close();
  if (external) { const exited = once(external, 'exit'); external.kill(); await exited; }
  if (wrong) await new Promise(resolveClosed => wrong.close(resolveClosed));
  assert.ok(resolve(workspace).startsWith(resolve('tests') + sep));
  await rm(workspace, { recursive: true, force: true });
}
