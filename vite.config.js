import { defineConfig } from 'vite';

// Vite picks up index.html at the project root and serves /src/main.js as the entry.
// API routes under /api/* are served by Vercel serverless functions in production.
// During `npm run dev` those routes are not available — use `vercel dev` (Phase 3) when wiring real APIs.
export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
