import { defineConfig } from 'vite';

// The Blender pipeline already writes everything the runtime needs into export/, so that
// folder IS the static root: /ube_office.glb, /seats.json, /obstacles.json,
// /characters/characters.json, /characters/eng_m1.glb. Nothing is copied or duplicated.
// Source lives in src/ precisely because publicDir is served verbatim.
export default defineConfig({
  publicDir: 'export',
  server: { open: true },
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
