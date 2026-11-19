import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// vitest shares this config, so tests get __APP_VERSION__ too.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    rollupOptions: {
      output: {
        // Rollup names dynamic chunks after the source file, so a package entry named index.mjs (shiki) yields a second
        // index-<hash>.js, which check-bundle-size.mjs's exactly-one-entry check rejects (#96). Use the package name.
        chunkFileNames(chunkInfo) {
          if (chunkInfo.name === "index") {
            const pkg = chunkInfo.facadeModuleId
              ?.match(/\.pnpm\/(.+?)@\d/)?.[1]
              ?.replace(/[@+]/g, "");
            return `assets/${pkg ?? "chunk"}-[hash].js`;
          }
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/collab": { target: "ws://localhost:3000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // Well above asyncUtilTimeout in test/setup.ts, so a slow wait fails with the query's own error, not a vitest timeout.
    testTimeout: 30_000,
  },
});
