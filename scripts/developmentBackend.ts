import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Reuse an existing backend; own only the process started by this dev server. */
export async function startDevelopmentBackend(target: string, root: string, workspace = join(root, '.vision-workspace')): Promise<() => void> {
  workspace = resolve(root, workspace);
  const probe = async () => {
    try {
      const response = await fetch(`${target}/api/v2/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return null;
      return await response.json() as { api?: string; schema?: string; controller?: boolean };
    } catch { return null; }
  };
  const validate = (health: { api?: string; schema?: string; controller?: boolean }) => {
    if (health.api !== 'v2' || health.schema !== 'vision.workspace/4' || health.controller !== true) {
      throw new Error(`VISION v2 core at ${target} is not ready: unexpected service or inactive controller. Run npm run core to inspect it.`);
    }
  };
  const existing = await probe();
  if (existing) { validate(existing); return () => {}; }

  const runtime = join(root, '.python313', 'python.exe');
  const url = new URL(target);
  const logDirectory = workspace;
  mkdirSync(logDirectory, { recursive: true });
  const log = createWriteStream(join(logDirectory, 'backend.log'), { flags: 'a' });
  log.on('error', error => console.warn(`Cannot write v2 core log: ${error.message}`));
  log.write(`\n[${new Date().toISOString()}] Starting backend at ${target}\n`);
  const child = spawn(existsSync(runtime) ? runtime : 'python', ['-u', '-m', 'backend.vision', '--port', url.port || '8112', '--workspace', workspace], {
    cwd: root, windowsHide: true,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  const capture = (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
    if (!log.destroyed) log.write(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', error => { diagnostics = error.message; });
  child.once('close', (code, signal) => {
    if (!log.destroyed) log.end(`[${new Date().toISOString()}] Backend exited: code=${code}, signal=${signal}\n`);
  });
  const stop = () => { if (child.exitCode === null) child.kill(); };
  process.once('exit', stop);
  const dispose = () => { process.removeListener('exit', stop); stop(); };
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const health = await probe();
      if (health) { validate(health); return dispose; }
      if (child.exitCode !== null) break;
      await delay(200);
    }
    throw new Error(`Cannot start VISION v2 core at ${target}. Run npm run core to inspect it; install backend/requirements.txt if needed. ${diagnostics}`);
  } catch (error) { dispose(); throw error; }
}
