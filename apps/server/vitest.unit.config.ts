import { defineConfig } from "vitest/config";

// No globalSetup, so unit tests never start testcontainers.
export default defineConfig({
  test: { include: ["test/unit/**/*.test.ts"] },
});
