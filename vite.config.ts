import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend dev server proxies /api to the Express server so we avoid CORS
// and can open a single URL (http://localhost:5173) during development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      // Dedicated WS path for the embedded terminal — kept off '/api' so SSE + HMR are unaffected.
      '/terminal-ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
