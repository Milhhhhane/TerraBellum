import { defineConfig } from "vite";

// Le client vit dans src/web. Il est compilé dans ./dist, que le Worker sert.
// En dev "rapide" (`npm run dev:web`), les appels /api partent vers `wrangler dev`.
export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    // MapLibre (~1 Mo) est gros par nature : on relève le seuil d'alerte.
    chunkSizeWarningLimit: 1500,
  },
  // Le worker de MapLibre est un module ES.
  worker: {
    format: "es",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
