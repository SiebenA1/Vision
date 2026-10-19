// Real local-runtime regression; no AI credentials or mocked CAD responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

delete process.env.VISION_ENGINEERING_URL;
process.env.VISION_ENGINEERING_PORT = '8120';
const backendUrl = 'http://127.0.0.1:8120';
const frontendUrl = 'http://127.0.0.1:4176';
const create = () => createServer({ server: { host: '127.0.0.1', port: 4176, strictPort: true } });
async function health() {
  try { return await (await fetch(`${backendUrl}/health`, {signal:AbortSignal.timeout(1500)})).json(); }
  catch { return null; }
}
let server, external;
try {
  assert.equal(await health(), null, 'test port 8120 must be free');
  server = await create();
  await server.listen();
  let response = await fetch(`${frontendUrl}/api/engineering/cad/capabilities?q=create_box`);
  let data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.entries.some(entry => entry.name === 'create_box'));
  response = await fetch(`${frontendUrl}/api/engineering/cad/execute`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({script:'result=u.create_box((0,0,0),100,20,10)'}),
  });
  data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.schema, 'vision.cad/3');
  assert.ok(Math.abs(data.metrics.volume_mm3 - 20000) < .00001);
  assert.ok(data.stlBytes > 84);
  console.log('PASS auto-start -> proxy API discovery -> real native box (20000 mm3)');
  await server.close(); server = null;
  for (let attempt=0; attempt<30 && await health(); attempt++) await delay(100);
  assert.equal(await health(), null, 'closing Vite must stop its owned backend');
  console.log('PASS owned backend lifecycle');

  external = spawn('.python313/python.exe', ['-u','server/engineering_server.py'], {
    env:{...process.env,VISION_ENGINEERING_PORT:'8120'}, windowsHide:true, stdio:'ignore',
  });
  for (let attempt=0;attempt<30;attempt++) { if ((await health())?.ok) break; await delay(200); }
  assert.equal((await health())?.ok, true);
  server = await create(); await server.listen(); await server.close(); server = null;
  assert.equal((await health())?.ok, true, 'Vite must not stop an existing backend');
  console.log('PASS existing backend reuse and ownership');
  server = await create(); await server.listen();
  const exited = once(external,'exit'); external.kill(); await exited; external=null;
  response = await fetch(`${frontendUrl}/api/engineering/cad/capabilities?q=create_box`);
  data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'ENGINEERING_BACKEND_UNAVAILABLE');
  assert.ok(data.error.includes('8120'));
  console.log('PASS stopped backend -> actionable JSON 503');
} finally {
  if (server) await server.close();
  external?.kill();
}
