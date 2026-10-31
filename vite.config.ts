import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { startDevelopmentBackend } from './scripts/developmentBackend.js';

function coreBackendPlugin(target: string, managed: boolean, workspace?: string): Plugin {
  const start = async (server: { httpServer: NonNullable<import('vite').ViteDevServer['httpServer']>; config: { root: string; logger: { info: (message: string) => void } } }) => {
    if (!managed) return;
    const stop = await startDevelopmentBackend(target, server.config.root, workspace);
    server.httpServer.once('close', stop);
    server.config.logger.info(`VISION v2 core ready: ${target}`);
  };
  return {
    name: 'vision-core-backend',
    async configureServer(server) { if (server.httpServer) await start({ ...server, httpServer: server.httpServer }); },
    async configurePreviewServer(server) { await start(server); },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const externalCore = process.env.VISION_CORE_URL || env.VISION_CORE_URL;
  const coreTarget = externalCore || `http://127.0.0.1:${process.env.VISION_CORE_PORT || env.VISION_CORE_PORT || '8112'}`;
  const coreWorkspace = process.env.VISION_CORE_WORKSPACE || env.VISION_CORE_WORKSPACE;
  const proxy = {
    '/api/v2': {
      target: coreTarget,
      changeOrigin: false,
      timeout: 30_000,
      proxyTimeout: 30_000,
      configure: (proxyServer: any) => {
        proxyServer.on('error', (_error: Error, _request: unknown, response: import('node:http').ServerResponse) => {
          if (response.headersSent || response.writableEnded || typeof response.writeHead !== 'function') return;
          response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ code: 'CORE_BACKEND_UNAVAILABLE', detail: `工程核心不可用（${coreTarget}）。请检查独立服务，或重启 npm run dev 自动启动 v2 核心。` }));
        });
      },
    },
  };
  return {
    plugins: [react(), coreBackendPlugin(coreTarget, !externalCore, coreWorkspace)],
    server: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1200 },
    worker: { format: 'es' },
  };
});
