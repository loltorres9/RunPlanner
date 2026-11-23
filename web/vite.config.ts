import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
