import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Die Version steht im package.json der Wurzel und wird bei jeder Änderung erhöht.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
// Railway reicht den Commit beim Bauen herein; lokal bleibt er leer.
const commit = (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  build: {
    outDir: 'dist',
    // Quellkarten bleiben draußen: Die App läuft auf einem oeffentlich erreichbaren
    // Server, und niemand außer uns muss sie debuggen können.
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Im lokalen Betrieb läuft der Server getrennt; im Container liefert er die
    // gebaute App selbst aus, dann greift diese Weiterleitung nicht mehr.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
