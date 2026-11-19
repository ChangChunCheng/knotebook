import { request as pwRequest, type FullConfig } from "@playwright/test";
import { E2E_ORIGIN } from "./ports.js";
import { ADMIN } from "./tests/helpers.js";

/**
 * Runs once before all specs: creates an enabled "SSO" provider with auto-create accounts on, pointing at fake-idp's root issuer
 * (client credentials in `stubs/fake-idp.mjs`). Specs locate its button by "Sign in with SSO".
 * Idempotent when the stack is re-run without `down`: an existing "SSO" provider is not recreated but is still PATCHed
 * enabled, because a failed earlier run can leave it disabled.
 * The callback URL is the regular `/api/auth/oidc/callback/<id>` form; the admin API cannot create a provider with a legacy callback URL (that case is covered by server integration tests).
 */
const SSO_NAME = "SSO";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? E2E_ORIGIN;
  const api = await pwRequest.newContext({ baseURL });
  const check = async (res: Awaited<ReturnType<typeof api.get>>, what: string) => {
    if (!res.ok()) throw new Error(`global-setup：${what} → HTTP ${res.status()} ${await res.text()}`);
    return res;
  };
  try {
    await check(await api.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } }), "管理員登入");
    const list = (await (await check(await api.get("/api/admin/auth/providers"), "列出登入服務")).json()) as { providers: Array<{ id: string; displayName: string }> };
    const existing = list.providers.find(p => p.displayName === SSO_NAME);
    const id = existing?.id ?? (await (
      await check(
        await api.post("/api/admin/auth/providers", {
          data: { template: "oidc", displayName: SSO_NAME, issuerUrl: "http://fake-idp:9400", clientId: "knotebook-e2e", clientSecret: "e2e-oidc-secret" },
        }),
        "建立 SSO 服務",
      )
    ).json() as { id: string }).id;
    // Creation always leaves it disabled with auto-create off; the secret is already sent, so enable it and turn auto-create on.
    await check(await api.patch(`/api/admin/auth/providers/${id}`, { data: { enabled: true, autoCreateEnabled: true } }), "啟用 SSO 服務");
  } finally {
    await api.dispose();
  }
}
