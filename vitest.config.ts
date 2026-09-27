import { defineConfig } from "vitest/config";

// Config séparée de vite.config.ts (dont la racine est src/web) : les tests vivent dans ./test.
export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
  },
});
