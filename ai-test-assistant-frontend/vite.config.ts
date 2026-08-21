import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// add or update server.proxy so dev requests to /audit are proxied to backend and avoid CORS
export default defineConfig({
  plugins: [react()],
  server: {
    // host: true,
    // port: 5173,
    // allowHosts: ['*'],
    proxy: {
      // proxy REST and websocket upgrade for /audit
      '/audit': {
        target: process.env.VITE_API_URL || 'https://dx12348.etisalat.corp.ae',
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  }
})