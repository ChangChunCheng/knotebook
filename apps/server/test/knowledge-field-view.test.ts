import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { isKnowledgeFieldEnabled } from "@knotebook/shared";
import { knowledgeFieldOverrides, notes } from "../src/db/schema.js";
import { knowledgeFieldViewForNote } from "../src/knowledge/fields/queries.js";
import { buildTestApp } from "./helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";

describe("knowledgeFieldViewForNote", () => {
  it("a group note gets its group's view; a trashed, missing or malformed note gets the site's", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Research", [{ userId: alice.id, role: "admin" }]);
    const note = await seedNote(db, { groupId: g.id });
    await db.insert(knowledgeFieldOverrides).values({ groupId: g.id, fieldRef: "when", optionKey: "", enabled: false });
    const whenOn = async (id: string) => isKnowledgeFieldEnabled(await knowledgeFieldViewForNote(db, id), "when");

    expect(await whenOn(note.id)).toBe(false);
    expect(await whenOn(note.id.toUpperCase())).toBe(false);
    await db.update(notes).set({ deletedAt: new Date(), deletedBy: alice.id }).where(eq(notes.id, note.id));
    expect(await whenOn(note.id)).toBe(true);
    expect(await whenOn("00000000-0000-4000-8000-00000000dead")).toBe(true);
    expect(await whenOn("not-a-uuid")).toBe(true);
  });
});
