import { describe, expect, it } from "vitest";
import { markPending } from "../src/collab/versions.js";
import type { Db } from "../src/db/index.js";
import { seedDoc } from "./copy-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { paraDoc, versionsOf } from "./version-helpers.js";

/** A note with content whose pending time is 6 minutes ago (site setting X = 5 minutes -> already due). */
async function duePending(db: Db, ownerId: string, text: string): Promise<string> {
  const n = await seedNote(db, { ownerId });
  await seedDoc(db, n.id, paraDoc([text]));
  await markPending(db, { noteId: n.id, at: new Date(Date.now() - 6 * 60_000), add: [{ user_id: ownerId, agent_label: null }], ref: null, spaceKey: `u:${ownerId}` });
  return n.id;
}

describe("auto-cut scan schedule", () => {
  it("startVersionJobs + versionAutoScanIntervalMs -> periodic scan cuts due notes; no more scans after app.close()", async () => {
    const { app, db } = await buildTestApp({ startVersionJobs: true, versionAutoScanIntervalMs: 50 });
    const u = await seedUser(db);
    const a = await duePending(db, u.id, "排程切的");
    await expect.poll(async () => (await versionsOf(db, a)).length, { timeout: 5_000 }).toBe(1);
    await app.close();
    const b = await duePending(db, u.id, "關了之後");
    await new Promise(r => setTimeout(r, 300));
    expect(await versionsOf(db, b)).toEqual([]);
  });

  it("without startVersionJobs (the test app default) -> nothing scheduled", async () => {
    const { app, db } = await buildTestApp({ versionAutoScanIntervalMs: 50 });
    const u = await seedUser(db);
    const a = await duePending(db, u.id, "沒有排程");
    await new Promise(r => setTimeout(r, 300));
    expect(await versionsOf(db, a)).toEqual([]);
    await app.close();
  });
});
