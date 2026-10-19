import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { startDevelopmentBackend } from './scripts/developmentBackend.js';

function engineeringBackendPlugin(target: string, managed: boolean): Plugin {
  const start = async (server: { httpServer: NonNullable<import('vite').ViteDevServer['httpServer']>; config: { root: string; logger: { info: (message: string) => void } } }) => {
    if (!managed) return;
    const stop = await startDevelopmentBackend(target, server.config.root);
    server.httpServer.once('close', stop);
    server.config.logger.info(`Engineering backend ready: ${target}`);
  };
  return {
    name: 'vision-engineering-backend',
    async configureServer(server) { if (server.httpServer) await start({ ...server, httpServer: server.httpServer }); },
    async configurePreviewServer(server) { await start(server); },
  };
}

interface GatewayConfig {
  hasServerKey: boolean;
  target: string;
}

function deepseekStatusPlugin(config: GatewayConfig): Plugin {
  const handleStatus = (_req: unknown, res: import('node:http').ServerResponse) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        provider: 'deepseek',
        gateway: 'vite-local-proxy',
        hasServerKey: config.hasServerKey,
        target: config.target,
        models: ['deepseek-flash', 'deepseek-v4-pro'],
      }),
    );
  };

  return {
    name: 'vision-deepseek-status',
    configureServer(server) {
      server.middlewares.use('/api/llm/status', handleStatus);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/llm/status', handleStatus);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const externalBackend = process.env.VISION_ENGINEERING_URL || env.VISION_ENGINEERING_URL;
  const engineeringTarget = externalBackend || `http://127.0.0.1:${process.env.VISION_ENGINEERING_PORT || env.VISION_ENGINEERING_PORT || '8111'}`;
  const apiKey = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';
  const target = (process.env.DEEPSEEK_API_BASE || env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(
    /\/$/,
    '',
  );

  const proxy = {
    '/api/engineering': {
      target: engineeringTarget,
      changeOrigin: false,
      // Outlast the 600s solve budget and optional native geometry preflight.
      timeout: 900_000,
      proxyTimeout: 900_000,
      rewrite: (path: string) => path.replace(/^\/api\/engineering/, ''),
      configure: (proxyServer: any) => {
        proxyServer.on('error', (_error: Error, _request: unknown, response: import('node:http').ServerResponse) => {
          if (response.headersSent || response.writableEnded || typeof response.writeHead !== 'function') return;
          response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: `计算后端不可用（${engineeringTarget}）。请检查后端进程，或重启 npm run dev 自动启动本地后端。`, code: 'ENGINEERING_BACKEND_UNAVAILABLE' }));
        });
      },
    },
    '/api/deepseek': {
      target,
      changeOrigin: true,
      secure: true,
      timeout: 300_000,
      proxyTimeout: 300_000,
      rewrite: (path: string) => path.replace(/^\/api\/deepseek/, ''),
      configure: (proxyServer: any) => {
        proxyServer.on('proxyReq', (proxyReq: import('node:http').ClientRequest) => {
          // Server-side key wins. Browser-entered keys are forwarded only when
          // the local gateway has no environment credential.
          if (apiKey) proxyReq.setHeader('authorization', `Bearer ${apiKey}`);
          proxyReq.setHeader('accept-encoding', 'identity');
        });
        proxyServer.on('proxyRes', (proxyRes: import('node:http').IncomingMessage) => {
          if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            proxyRes.headers['x-accel-buffering'] = 'no';
            delete proxyRes.headers['content-length'];
          }
        });
      },
    },
  };

  return {
    plugins: [react(), engineeringBackendPlugin(engineeringTarget, !externalBackend), deepseekStatusPlugin({ hasServerKey: Boolean(apiKey), target })],
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy,
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
    },
    worker: {
      format: 'es',
    },
  };
});
