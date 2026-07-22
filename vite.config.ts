import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPort, webPort } from './shared/ports.js';

// Frontend dev server proxies /api to the Express server so we avoid CORS and can open a single URL
// during development. Both ports come from shared/ports so a worktree's UI can only ever talk to its
// OWN API (tkt-4b74943a319e) — set KANBAN_PORT_OFFSET to run a second checkout alongside this one.
const api = apiPort();

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort(),
    // Fail loudly on a taken port. The default fallback-to-next-free silently produces the worst
    // outcome available: a second worktree serving its own UI against the first worktree's API.
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${api}`,
      // Dedicated WS path for the embedded terminal — kept off '/api' so SSE + HMR are unaffected.
      '/terminal-ws': { target: `ws://localhost:${api}`, ws: true },
    },
  },
});
