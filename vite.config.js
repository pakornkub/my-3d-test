import { defineConfig } from 'vite';

// GitHub Pages serves this repo under /my-3d-test/, so the built asset URLs need that
// prefix while `npm run dev` stays at /. Runtime fetches use import.meta.env.BASE_URL,
// which Vite fills in from this value -- see src/main.js.
const base = process.env.GITHUB_ACTIONS ? '/my-3d-test/' : '/';

// The Blender pipeline already writes everything the runtime needs into export/, so that
// folder IS the static root: /ube_office.glb, /seats.json, /obstacles.json,
// /characters/*. Nothing is copied or duplicated. Source lives in src/ precisely because
// publicDir is served verbatim.
export default defineConfig({
  base,
  publicDir: 'export',
  server: {
    open: true,
    // the scene talks to the Office Server (server/index.mjs) over one WebSocket path, so the
    // browser only ever sees the Vite origin -- no CORS, no second port to remember
    // OFFICE_PORT lets a ticket worktree's dev server reach that worktree's own Office Server
    // (server/pipeline.mjs starts one per QA run) instead of the shared one
    proxy: { '/office': { target: `ws://localhost:${process.env.OFFICE_PORT ?? 5181}`, ws: true, rewriteWsOrigin: true } },
  },
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
