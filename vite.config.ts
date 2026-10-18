import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
  const apiKey = process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';
  const target = (process.env.DEEPSEEK_API_BASE || env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(
    /\/$/,
    '',
  );

  const proxy = {
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
    plugins: [react(), deepseekStatusPlugin({ hasServerKey: Boolean(apiKey), target })],
    server: {
      host: '127.0.0.1',
      port: 4173,
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
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
