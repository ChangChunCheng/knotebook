import { defineConfig } from "@playwright/test";
import { E2E_ORIGIN, IDP_PORT } from "./ports.js";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  workers: 1, // specs share one stack, so run serially
  timeout: 60_000,
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
    locale: "en-US", // assertions pin English copy; a fixed locale keeps getByText independent of the runner's OS language
    launchOptions: { args: [`--host-resolver-rules=MAP fake-idp:9400 127.0.0.1:${IDP_PORT}`] }, // issuer must be the fixed fake-idp:9400 inside containers while the published local port varies
  },
});
