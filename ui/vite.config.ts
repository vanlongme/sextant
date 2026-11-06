import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // Monaco's lazy chunk is far over the default warning, and is meant to be.
  build: { chunkSizeWarningLimit: 5000 },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    setupFiles: "src/test/setup.ts",
    // Real CSS, so tests can read computed styles, with stable class names.
    css: {
      include: /.+/,
      modules: { classNameStrategy: "non-scoped" },
    },
  },
});
