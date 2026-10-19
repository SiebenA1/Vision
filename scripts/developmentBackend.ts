import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Reuse an existing backend; own only the process started by this dev server. */
export async function startDevelopmentBackend(target: string, root: string): Promise<() => void> {
  const probe = async () => {
    try {
      const response = await fetch(`${target}/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return null;
      return await response.json() as { ok: boolean; cad_kernel?: string; error?: string };
    } catch { return null; }
  };
  const validate = (health: { ok: boolean; cad_kernel?: string; error?: string }) => {
    if (!health.ok || health.cad_kernel !== 'NVIDIA USD BRep') {
      throw new Error(`Engineering backend at ${target} is not ready: ${health.error ?? 'unexpected service'}. Run python scripts/setup_native.py --fea.`);
    }
  };
  const existing = await probe();
  if (existing) { validate(existing); return () => {}; }

  const runtime = join(root, '.python313', 'python.exe');
  const url = new URL(target);
  const child = spawn(existsSync(runtime) ? runtime : 'python', ['-u', join(root, 'server', 'engineering_server.py')], {
    cwd: root, windowsHide: true,
    env: { ...process.env, VISION_ENGINEERING_HOST: url.hostname, VISION_ENGINEERING_PORT: url.port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  const capture = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', error => { diagnostics = error.message; });
  const stop = () => { if (child.exitCode === null) child.kill(); };
  process.once('exit', stop);
  const dispose = () => { process.removeListener('exit', stop); stop(); };
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const health = await probe();
      if (health) { validate(health); return dispose; }
      await delay(200);
    }
    throw new Error(`Cannot start Engineering backend at ${target}. Run npm run backend to inspect it. ${diagnostics}`);
  } catch (error) { dispose(); throw error; }
}
