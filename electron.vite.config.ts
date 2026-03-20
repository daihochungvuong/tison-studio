import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * Vite 插件：API CORS 代理
 * 在开发服务器上注册 /__api_proxy 中间件，
 * 将浏览器端的外部 API 请求由服务端转发，绕过 CORS 限制。
 */
function apiCorsProxyPlugin(): Plugin {
  return {
    name: 'api-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/__api_proxy', async (req, res) => {
        // OPTIONS 预检请求
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          });
          res.end();
          return;
        }

        // 解析目标 URL
        const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url');
        if (!urlParam) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
          return;
        }

        try {
          // 读取请求体
          const bodyChunks: Buffer[] = [];
          for await (const chunk of req) {
            bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

          // 解包原始请求头
          const proxyHeadersRaw = req.headers['x-proxy-headers'];
          let forwardHeaders: Record<string, string> = {};
          if (typeof proxyHeadersRaw === 'string') {
            try { forwardHeaders = JSON.parse(proxyHeadersRaw); } catch { /* ignore */ }
          }

          // 服务端转发
          const response = await fetch(urlParam, {
            method: req.method || 'GET',
            headers: forwardHeaders,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
          });

          const respBody = await response.arrayBuffer();
          const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
          const ct = response.headers.get('content-type');
          if (ct) headers['Content-Type'] = ct;

          res.writeHead(response.status, headers);
          res.end(Buffer.from(respBody));
        } catch (err: any) {
          const cause = err?.cause?.message || err?.cause?.code || '';
          console.error(`[api-cors-proxy] Unexpected error: ${err?.message}${cause ? ' | cause: ' + cause : ''}`);
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'Proxy request failed', detail: err?.message, cause }));
        }
      });
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/main.ts')
        },
        output: {
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/preload.ts')
        },
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@opencut/ai-core/services/prompt-compiler': path.resolve(__dirname, './src/packages/ai-core/services/prompt-compiler.ts'),
        '@opencut/ai-core/api/task-poller': path.resolve(__dirname, './src/packages/ai-core/api/task-poller.ts'),
        '@opencut/ai-core/protocol': path.resolve(__dirname, './src/packages/ai-core/protocol/index.ts'),
        '@opencut/ai-core': path.resolve(__dirname, './src/packages/ai-core/index.ts'),
      },
    },
    plugins: [
      apiCorsProxyPlugin(),
      react(),
    ],
  },
})
