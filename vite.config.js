import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// After a build, stamp the service worker with a build id and the entry files
// (index.html's scripts and styles), so the app shell works offline and each
// deploy gets a fresh cache.
function serviceWorkerManifest() {
  let outDir = 'dist';
  return {
    name: 'jarvis-sw-manifest',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const swPath = resolve(outDir, 'sw.js');
      const htmlPath = resolve(outDir, 'index.html');
      if (!existsSync(swPath) || !existsSync(htmlPath)) return;
      const html = readFileSync(htmlPath, 'utf8');
      const entry = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
      const sw = readFileSync(swPath, 'utf8')
        .replace("'__BUILD_ID__'", JSON.stringify(Date.now().toString(36)))
        .replace('[] /* __ENTRY_ASSETS__ */', JSON.stringify(entry));
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerManifest()],
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1600 },
});
