import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { uniqueViolationConstraint } from "../src/db/pg-errors.js";
import { noteRedirects, notes } from "../src/db/schema.js";
import { writeSlugInTx } from "../src/notes/tx/write-slug.js";
import { insertNoteWithAutoSlug } from "../src/notes/create.js";
import { buildTestApp } from "./helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";

// "Racing" writes are produced by inserting a same-name row (`db`, already committed) over a separate connection, via the
// `beforeWrite`/`beforeInsert` hooks between the probe and the write.
describe("writeSlugInTx", () => {
  it("group-scope collision -> -2, the row belongs to the target group after writing", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id }, { slug: "dup" });
    const mine = await seedNote(db, { ownerId: u.id }, { slug: "dup" }); // this row was in the personal scope with the same name dup; scope determination is guarded by the next case
    const slug = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "dup" }, async s => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: s }).where(eq(notes.id, mine.id));
      }, { excludeNoteId: mine.id }),
    );
    expect(slug).toBe("dup-2");
    const [row] = await db.select().from(notes).where(eq(notes.id, mine.id));
    expect(row).toMatchObject({ groupId: g.id, ownerId: null, slug: "dup-2" });
  });

  it("scope only looks at the target group: another owner's personal note of the same name is not a collision -> returns the base itself", async () => {
    const { db } = await buildTestApp();
    const [u, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await seedNote(db, { ownerId: other.id }, { slug: "solo" }); // outside the group, someone else's personal scope
    const mine = await seedNote(db, { ownerId: u.id });
    const slug = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "solo" }, async s => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: s }).where(eq(notes.id, mine.id));
      }, { excludeNoteId: mine.id }),
    );
    expect(slug).toBe("solo");
  });

  it("row already in the target scope with the same base slug -> excluded, returns the original slug (doesn't count itself as taken)", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "same" });
    const slug = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "same" }, async s => {
        await tx.update(notes).set({ slug: s }).where(eq(notes.id, n.id));
      }, { excludeNoteId: n.id }),
    );
    expect(slug).toBe("same");
  });

  it("same name written first by someone else after the probe (beforeWrite hook) -> savepoint rolls back, re-probe succeeds, and later statements in the outer transaction still work (not 25P02)", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "race" });
    const seen: string[] = [];
    const out = await db.transaction(async tx => {
      const s = await writeSlugInTx(tx, { groupId: g.id }, { base: "race" }, async c => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: c }).where(eq(notes.id, n.id));
      }, {
        excludeNoteId: n.id,
        beforeWrite: async c => {
          seen.push(c);
          if (seen.length === 1) await seedNote(db, { groupId: g.id }, { slug: c }); // another connection, already committed
        },
      });
      const [again] = await tx.select({ slug: notes.slug }).from(notes).where(eq(notes.id, n.id)); // the outer transaction is still usable
      return { s, again: again!.slug };
    });
    expect(seen).toEqual(["race", "race-2"]);
    expect(out).toEqual({ s: "race-2", again: "race-2" });
  });

  it("retries exhausted -> fallbackAutoSlug (untitled-<8 hex>)", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "x" });
    const seen: string[] = [];
    const s = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "x" }, async c => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: c }).where(eq(notes.id, n.id));
      }, { excludeNoteId: n.id, beforeWrite: async c => { seen.push(c); if (!c.startsWith("untitled-")) await seedNote(db, { groupId: g.id }, { slug: c }); } }),
    );
    expect(s).toMatch(/^untitled-[0-9a-f]{8}$/);
    // The retry round count is pinned: 5 probe rounds (x, x-2 ... x-5) are all raced and the 6th falls back (changing the threshold `>` to `>=` would lose a round)
    expect(seen.slice(0, 5)).toEqual(["x", "x-2", "x-3", "x-4", "x-5"]);
    expect(seen).toHaveLength(6);
    expect(seen[5]).toMatch(/^untitled-/);
  });

  it("a non-slug 23505 is rethrown as is, no retry (split by constraint name)", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    let calls = 0;
    // drizzle 0.44 wraps pg errors in DrizzleQueryError (the original is in `.cause`): take the constraint name via the check in `db/pg-errors.ts`.
    const err = await db
      .transaction(tx =>
        writeSlugInTx(tx, { ownerId: u.id }, { base: "y" }, async () => {
          calls++;
          await tx.insert(noteRedirects).values([
            { oldPath: "/n/z/dup-pk", noteId: n.id, expiresAt: new Date(Date.now() + 1e6) },
            { oldPath: "/n/z/dup-pk", noteId: n.id, expiresAt: new Date(Date.now() + 1e6) },
          ]);
        }),
      )
      .then(() => null, (e: unknown) => e);
    expect(uniqueViolationConstraint(err)).toBe("note_redirects_pkey");
    expect(calls).toBe(1);
  });
});

describe("insertNoteWithAutoSlug inTx mode", () => {
  it("collision inside the transaction -> savepoint retry succeeds, later writes in the same transaction still work; the returned row belongs to that group", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id }, { slug: "plan" });
    let first = true;
    const row = await db.transaction(async tx => {
      const created = await insertNoteWithAutoSlug(tx, { scope: { groupId: g.id }, folderId: null }, "Plan", {
        beforeInsert: async c => { if (first) { first = false; await seedNote(db, { groupId: g.id }, { slug: c }); } },
      }, { inTx: true });
      await tx.update(notes).set({ title: "Plan!" }).where(eq(notes.id, created.id));
      return created;
    });
    expect(row.groupId).toBe(g.id);
    expect(row.slug).toBe("plan-3"); // plan was seeded, plan-2 was taken by beforeInsert
    const [after] = await db.select({ title: notes.title }).from(notes).where(and(eq(notes.id, row.id)));
    expect(after!.title).toBe("Plan!");
  });
});
