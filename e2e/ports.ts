/**
 * Defaults match CI; `scripts/test-e2e.sh` picks free ports locally and passes them as `E2E_PORT` / `E2E_IDP_PORT`,
 * which `docker-compose.e2e.yml` reads too.
 */
export const APP_PORT = Number(process.env.E2E_PORT || 3100);
export const IDP_PORT = Number(process.env.E2E_IDP_PORT || 9400);
export const E2E_ORIGIN = `http://localhost:${APP_PORT}`;
/** The `request` fixture ignores the browser's host-resolver-rules, so control endpoints are reached through this origin. */
export const IDP_CONTROL_ORIGIN = `http://localhost:${IDP_PORT}`;
