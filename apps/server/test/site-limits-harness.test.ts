import { describe, expect, it } from "vitest";
import { siteLimits as siteLimitsTable } from "../src/db/schema.js";
import { SiteLimits } from "../src/site-limits/store.js";
import { buildCollabTestApp, buildTestApp, freshDb, testConfig } from "./helpers.js";

describe("siteLimits in buildTestApp", () => {
  it("overriding config's limitEnv reaches siteLimits", async () => {
    const { siteLimits } = await buildTestApp({ config: { ...testConfig, limitEnv: { noteMaxBytes: 2097152 } } });
    expect(siteLimits.envName("noteMaxBytes")).toBe("NOTE_MAX_BYTES");
    expect(siteLimits.get("noteMaxBytes")).toBe(2097152);
  });

  it("overriding db binds siteLimits to the same DB", async () => {
    const { db } = await freshDb();
    await db.insert(siteLimitsTable).values({ key: "rateEdit", value: 10 });
    const { siteLimits, db: appDb } = await buildTestApp({ db });
    expect(appDb).toBe(db);
    expect(siteLimits.get("rateEdit")).toBe(10);
  });

  it("a given siteLimits is used as is", async () => {
    const given = SiteLimits.defaults({ machine: testConfig.machine });
    const { siteLimits } = await buildTestApp({ siteLimits: given });
    expect(siteLimits).toBe(given);
  });
});

describe("siteLimits in buildCollabTestApp", () => {
  it("overriding config's limitEnv reaches siteLimits", async () => {
    const { siteLimits } = await buildCollabTestApp({ config: { ...testConfig, limitEnv: { noteMaxBytes: 2097152 } } });
    expect(siteLimits.envName("noteMaxBytes")).toBe("NOTE_MAX_BYTES");
    expect(siteLimits.get("noteMaxBytes")).toBe(2097152);
  });

  it("overriding db binds siteLimits to the same DB", async () => {
    const { db } = await freshDb();
    await db.insert(siteLimitsTable).values({ key: "rateEdit", value: 10 });
    const ctx = await buildCollabTestApp({ db });
    expect(ctx.db).toBe(db);
    expect(ctx.siteLimits.get("rateEdit")).toBe(10);
  });

  it("a given siteLimits is used as is", async () => {
    const given = SiteLimits.defaults({ machine: testConfig.machine });
    const ctx = await buildCollabTestApp({ siteLimits: given });
    expect(ctx.siteLimits).toBe(given);
  });
});
