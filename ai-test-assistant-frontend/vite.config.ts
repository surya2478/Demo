import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-server proxy for /audit, so browser requests reach the backend without
// tripping CORS. This block applies to `vite dev` only -- a production build is
// served by nginx and never sees it.
export default defineConfig(({ mode }) => {
  // loadEnv, not process.env. This file runs in Node before import.meta.env
  // exists, so `process.env.VITE_API_URL` reads the SHELL environment -- which
  // is not where .env lives. The .env value was therefore ignored and the
  // fallback was always the real proxy target, which is easy to miss when the
  // fallback happens to be a host that resolves.
  const env = loadEnv(mode, process.cwd(), '')

  // Falls back to the local backend, because that is what a developer running
  // `npm run dev` with no configuration is running against. A remote host here
  // fails as a 502 from the proxy, which reads like the backend is down rather
  // than like a misconfigured target.
  const target = env.VITE_API_URL || 'http://127.0.0.1:8002'

  return {
    plugins: [react()],
    server: {
      // host: true,
      // port: 5173,
      proxy: {
        // proxy REST and websocket upgrade for /audit
        '/audit': {
          target,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
  }
})
