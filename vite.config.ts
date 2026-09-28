import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const page = (file: string) => fileURLToPath(new URL(`./src/web/${file}`, import.meta.url));

// Le client vit dans src/web. Il est compilé dans ./dist, que le Worker sert.
// En dev "rapide" (`npm run dev:web`), les appels /api partent vers `wrangler dev`.
export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    // MapLibre (~1 Mo) est gros par nature : on relève le seuil d'alerte.
    chunkSizeWarningLimit: 1500,
    // Deux pages : le jeu et l'administration (/admin).
    rollupOptions: {
      input: {
        main: page("index.html"),
        admin: page("admin.html"),
      },
    },
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
