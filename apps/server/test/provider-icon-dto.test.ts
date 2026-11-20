import { describe, expect, it } from "vitest";
import { userIdentities } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { adminApp } from "./helpers/admin-auth.js";
import { expectedIcon, expectNoIconBytes, seedIconMatrix } from "./helpers/provider-icon.js";

describe("provider DTO icon conversion", () => {
  it("GET /api/auth/config: 3 templates x 5 kinds each carry the converted icon; template/iconKind and image bytes are not exposed", async () => {
    const { app, db } = await buildTestApp();
    const matrix = await seedIconMatrix(db);
    const res = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toEqual(matrix.map(c => ({ id: c.id, displayName: c.displayName, icon: expectedIcon(c) })));
    expectNoIconBytes(res.body);
    expect(res.body).not.toContain("iconKind");
    expect(res.body).not.toContain('"template"');
  });

  it("GET /api/auth/identities: identities[].providers and linkable each carry icon (same conversion); no image bytes", async () => {
    const { app, db } = await buildTestApp();
    const matrix = await seedIconMatrix(db);
    const linked = await seedUser(db);
    await db.insert(userIdentities).values(matrix.map((c, i) => ({ userId: linked.id, issuer: c.issuer, sub: `s${i}` })));
    const mine = await app.inject({ method: "GET", url: "/api/auth/identities", cookies: await cookieOf(linked.id) });
    expect(mine.statusCode).toBe(200);
    const byIssuer = new Map((mine.json().identities as Array<{ issuer: string; providers: unknown[] }>).map(i => [i.issuer, i.providers]));
    for (const c of matrix) {
      expect(byIssuer.get(c.issuer), c.displayName).toEqual([{ id: c.id, displayName: c.displayName, icon: expectedIcon(c) }]);
    }
    expect(mine.json().linkable).toEqual([]);
    expectNoIconBytes(mine.body);

    const fresh = await seedUser(db);
    const other = await app.inject({ method: "GET", url: "/api/auth/identities", cookies: await cookieOf(fresh.id) });
    expect(other.json().linkable).toEqual(
      matrix.map(c => ({ providerId: c.id, displayName: c.displayName, template: c.template, icon: expectedIcon(c) })),
    );
    expectNoIconBytes(other.body);
  });

  it("admin GET /api/admin/auth/providers: each row has iconKind (raw value) and icon (same conversion); no image bytes", async () => {
    const { app, db, cookies } = await adminApp();
    const matrix = await seedIconMatrix(db);
    const res = await app.inject({ method: "GET", url: "/api/admin/auth/providers", cookies });
    expect(res.statusCode).toBe(200);
    const rows = res.json().providers as Array<{ id: string; iconKind: string; icon: unknown }>;
    for (const c of matrix) {
      expect(rows.find(r => r.id === c.id), c.displayName).toMatchObject({ iconKind: c.kind, icon: expectedIcon(c) });
    }
    expectNoIconBytes(res.body);
  });

  it("POST new provider -> iconKind 'template', icon is generic for every template", async () => {
    const { app, cookies } = await adminApp();
    for (const [template, icon] of [["gitlab", { type: "builtin", name: "generic" }], ["google", { type: "builtin", name: "generic" }], ["oidc", { type: "builtin", name: "generic" }]] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/auth/providers",
        cookies,
        payload: { template, displayName: `New ${template}`, issuerUrl: `https://new-${template}.example`, clientId: "c" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ iconKind: "template", icon });
    }
  });
});
