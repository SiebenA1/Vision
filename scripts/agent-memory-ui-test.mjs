// Controlled LLM + real HTTP/SQLite/native kernel. No external AI requests.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('server/.agent_memory', { recursive: true });
const directory = await mkdtemp(path.resolve('server/.agent_memory/ui-'));
process.env.VISION_ENGINEERING_URL = 'http://127.0.0.1:8119';
const backend = spawn('.python313/python.exe', ['-u', 'server/engineering_server.py'], {
  env: { ...process.env, VISION_ENGINEERING_PORT: '8119', VISION_MEMORY_DB: path.join(directory, 'memory.sqlite3') }, windowsHide: true,
});
let logs = '', server, browser, page;
backend.stderr.on('data', chunk => { logs += chunk; });
const post = async (route, body) => {
  const response = await fetch(`http://127.0.0.1:8119${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await (await fetch('http://127.0.0.1:8119/health')).json()).memory_schema) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const indexResponse = await fetch('http://127.0.0.1:8119/cad/api-index');
  const apiIndex = await indexResponse.json();
  assert.equal(indexResponse.status, 200);
  assert.ok(apiIndex.entries.some(entry => entry.symbol === 'usd_brep.create_box' && entry.signature));
  assert.equal((await fetch('http://127.0.0.1:8119/cad/api-index', { headers: { 'If-None-Match': indexResponse.headers.get('etag') } })).status, 304);
  const boxDocs = await (await fetch('http://127.0.0.1:8119/cad/capabilities?q=usd_brep.create_box')).json();
  assert.equal(boxDocs.entries[0].symbol, 'usd_brep.create_box');
  const script = "result={'housing':u.boolean_difference(u.create_box((-40,-20,-10),80,40,20),u.create_cylinder((-20,0,-11),6,22))}";
  const cad = await post('/cad/execute', { script });
  const probe = await post('/cad/inspect', { artifactId: cad.artifactId, selection: cad.bodies[0].faces.map(face => face.id) });
  const face = probe.selectionContext.selected.find(item => item.planar && item.boundaryLoops.length === 2);
  assert.ok(face);
  server = await createServer({ server: { host: '127.0.0.1', port: 4179, strictPort: true } }); await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1550, height: 1050 } }); page.setDefaultTimeout(20000);
  const errors = [], chatContexts = [], inspectionContexts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/llm/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ hasServerKey: true, provider: 'deepseek' }) }));
  await page.route('**/api/deepseek/chat/completions', route => {
    const request = route.request().postDataJSON();
    let message;
    const chat = request.messages.find(message => message.role === 'user' && message.content?.includes('engineering_context_data'));
    if (chat) {
      const context = JSON.parse(chat.content); chatContexts.push(context);
      assert.equal(context.kernelApiIndex.fingerprint, apiIndex.fingerprint);
      assert.ok(context.kernelApiIndex.groups.primitives.some(signature => signature.startsWith('create_box(')));
      assert.ok(!request.messages[0].content.includes('Current engineering context (authoritative JSON snapshot)'));
      if (chatContexts.length === 1) {
        assert.deepEqual(context.currentSelection, [face.id]);
        message = { content: null, tool_calls: [
          { id: 'intent-seal', type: 'function', function: { name: 'update_task_intent', arguments: JSON.stringify({ sourceEventId: context.userSourceEventId, goal: '针对用户声明的密封接口面关注相关几何尺寸', relation: 'new', basedOnEventIds: [], unresolved: [] }) } },
          { id: 'remember-seal', type: 'function', function: { name: 'remember_engineering_intent', arguments: JSON.stringify({ sourceEventId: context.userSourceEventId, content: '此面用于密封，关注接口尺寸', topic: '密封用途', kind: 'requirement', target: face.id }) } },
        ] };
      } else if (chatContexts.length === 4) {
        message = { content: null, tool_calls: [
          { id: 'intent-material', type: 'function', function: { name: 'update_task_intent', arguments: JSON.stringify({ sourceEventId: context.userSourceEventId, goal: '保留当前几何和密封用途，将材料改为合金钢', relation: 'revise', basedOnEventIds: [context.engineeringMemory.interpretedIntent.eventId], unresolved: [] }) } },
          { id: 'material-change', type: 'function', function: { name: 'set_material', arguments: JSON.stringify({ materialId: 'STEEL-4340' }) } },
        ] };
      } else if (chatContexts.length === 6) {
        const item = context.engineeringMemory.memories.find(item => item.topic === '密封用途');
        message = { content: null, tool_calls: [
          { id: 'intent-forget', type: 'function', function: { name: 'update_task_intent', arguments: JSON.stringify({ sourceEventId: context.userSourceEventId, goal: '按用户要求忘记此前密封用途，不修改几何', relation: 'cancel', basedOnEventIds: [context.engineeringMemory.interpretedIntent.eventId], unresolved: [] }) } },
          { id: 'forget-seal', type: 'function', function: { name: 'withdraw_engineering_memory', arguments: JSON.stringify({ sourceEventId: context.userSourceEventId, id: item.id, action: 'forget' }) } },
        ] };
      } else if (chatContexts.length === 7) {
        assert.equal(context.engineeringMemory.memories.length, 0);
        assert.ok(!JSON.stringify(request.messages).includes('此面用于密封，关注接口尺寸'));
        message = { content: '已忘记此前用途声明，几何保持不变。' };
      } else {
        assert.ok(context.engineeringMemory.memories.some(item => item.content === '此面用于密封，关注接口尺寸'));
        if (chatContexts.length === 5) {
          assert.equal(context.material.rho_kg_m3, 7850);
          assert.equal(context.engineeringMemory.toolOutputs[0].origin, 'tool_executor');
          assert.equal(context.engineeringMemory.toolOutputs[0].validity, 'current');
        }
        message = { content: '已记录密封用途。未把用途声明当作实测结果。' };
      }
    } else {
      const context = JSON.parse(request.messages.at(-1).content); inspectionContexts.push(context);
      assert.ok(context.engineeringMemory.memories.some(item => item.content.includes('密封')));
      assert.equal(context.model.sourceScript, undefined);
      const area = context.availableMetrics.find(metric => metric.id === `${face.id}:area`);
      message = { content: JSON.stringify({ feature: { name: '用户声明的密封接口面', confidence: 'functional_inference', explanation: '密封用途来自用户声明，几何本身不证明密封性能。', evidenceIds: [face.id] }, parameters: [{ metricId: area.id, label: '密封接口有效面积', reason: '结合用户声明关注实际裁剪面积', display: 'primary' }], considerations: [{ name: '粗糙度要求', reason: '密封接口需要相关设计依据', requiredData: '用户尚未定义粗糙度', status: 'needs_context' }] }) };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: 'memory-fixture', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
  });
  await page.goto('http://127.0.0.1:4179', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('textbox', { name: '工程需求' }).waitFor();
  await page.evaluate(async ({ cad, script, faceId }) => {
    const { useAppStore } = await import('/src/state/store.ts');
    const { cadArtifactFromResult } = await import('/src/services/engineeringBackend.ts');
    const { useInspectionStore } = await import('/src/state/inspectionStore.ts');
    const { useLlmStore } = await import('/src/state/llmStore.ts');
    useLlmStore.setState(state => ({ serverKey: true, settings: { ...state.settings, preferDeepSeek: true, streaming: false, thinking: false } }));
    useAppStore.getState().adoptExternalModel({ name: '记忆回归模型', script, stlBase64: cad.stlBase64, metrics: cad.metrics, cad: cadArtifactFromResult(cad) });
    useAppStore.setState({ leftCollapsed: false, rail: 'model' });
    useAppStore.getState().syncProject();
    useInspectionStore.getState().setSmart(false);
    await useInspectionStore.getState().measure([faceId]);
    await (await import('/src/services/agent.ts')).sendAgentPrompt('此面用于密封，关注接口尺寸');
  }, { cad, script, faceId: face.id });
  assert.equal(chatContexts.length, 2);
  assert.equal(await page.getByRole('region', { name: '工程记忆', exact: true }).count(), 0);
  await page.reload();
  await page.getByRole('textbox', { name: '工程需求' }).waitFor();
  await page.evaluate(async () => {
    (await import('/src/state/store.ts')).useAppStore.setState({ leftCollapsed: false, rail: 'model' });
    const { useLlmStore } = await import('/src/state/llmStore.ts');
    useLlmStore.setState(state => ({ serverKey: true, settings: { ...state.settings, preferDeepSeek: true, streaming: false, thinking: false } }));
    await (await import('/src/services/agent.ts')).sendAgentPrompt('刚才说的用途是什么？');
  });
  assert.equal(chatContexts.length, 3);
  assert.equal(chatContexts[2].engineeringMemory.previousTask.status, 'completed');
  await page.evaluate(async () => { await (await import('/src/services/agent.ts')).sendAgentPrompt('把当前材料改为合金钢'); });
  assert.equal(chatContexts.length, 5);
  await page.evaluate(async faceId => {
    const { useInspectionStore } = await import('/src/state/inspectionStore.ts');
    useInspectionStore.getState().setSmart(true);
    await useInspectionStore.getState().measure([faceId]);
    window.__memoryInspectionStore = useInspectionStore;
  }, face.id);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__memoryInspectionStore.getState().analysisStatus));
  const state = await page.evaluate(() => { const state = window.__memoryInspectionStore.getState(); return { analysis: state.analysis, error: state.analysisError }; });
  assert.ok(state.analysis, state.error);
  assert.equal(inspectionContexts.length, 1);
  assert.ok(Math.abs(state.analysis.properties[0].value - (3200 - Math.PI * 36)) < (3200 - Math.PI * 36) * .0001);
  await mkdir('screenshots', { recursive: true });
  await page.screenshot({ path: 'screenshots/agent-memory.png' });
  await page.evaluate(async () => { await (await import('/src/services/agent.ts')).sendAgentPrompt('忘记前面的密封用途'); });
  assert.equal(chatContexts.length, 7);
  const forgotten = await page.evaluate(async () => {
    const memory = await import('/src/services/agentMemory.ts');
    return memory.memoryRequest('context', memory.memoryScope(), { purpose: 'chat', signature: '' });
  });
  assert.equal(forgotten.memories.length, 0);
  assert.ok(!JSON.stringify(forgotten).includes('此面用于密封，关注接口尺寸'));
  assert.equal(await page.evaluate(() => window.__memoryInspectionStore.getState().analysis), null);
  assert.deepEqual(errors, []);
  console.log('PASS: chat tool remembers verbatim user intent; SQLite survives reload; provider history restores; geometry inspection receives shared intent and real area; forget clears derived checkpoints; no external LLM requests or page errors');
} catch (error) {
  if (page) console.error('Browser errors:', await page.evaluate(() => document.body.innerText).catch(() => 'unavailable'));
  console.error(logs.slice(-2500));
  if (page) { await mkdir('screenshots', { recursive: true }); await page.screenshot({ path: 'screenshots/agent-memory-failure.png' }); }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  if (backend.exitCode === null) { const exited = new Promise(resolve => backend.once('exit', resolve)); backend.kill(); await exited; }
  await rm(directory, { recursive: true, force: true });
}
