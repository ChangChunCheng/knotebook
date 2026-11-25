import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { SearchTermsMode } from "@knotebook/shared";
import { freshDb } from "./helpers.js";
import { seedGroup, seedShare, seedUser } from "./group-helpers.js";
import { notes } from "../src/db/schema.js";
import { groupMatchesByNote, searchNotesForUser } from "../src/notes/search-query.js";
import { seedIndexedNote } from "./search-helpers.js";
import type { Db } from "../src/db/index.js";
import type { SearchPageKey } from "../src/notes/search-sql.js";

// #399: queries with two or more keywords. One-keyword behaviour is covered (unchanged) by search-query.test.ts.

const at = (db: Db, id: string, iso: string) => db.update(notes).set({ updatedAt: new Date(iso) }).where(eq(notes.id, id));
const search = (db: Db, userId: string, terms: string[], mode: SearchTermsMode = "all", extra: { limit?: number; bodyOnly?: boolean; page?: { after: SearchPageKey | null } } = {}) =>
  searchNotesForUser(db, { userId, terms, mode, limit: extra.limit ?? 20, ...(extra.bodyOnly ? { bodyOnly: true } : {}), ...(extra.page ? { page: extra.page } : {}) });
const idsOf = (r: { rows: Array<{ id: string }> }) => r.rows.map(x => x.id);

describe("all mode", () => {
  it("every keyword must appear, each in the title or the body, in any section; case-insensitive", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const split = await seedIndexedNote(db, { ownerId: u.id }, "Deploy guide", [{ id: "a", text: "steps for PROD" }, { id: "b", type: "heading", level: 2, text: "Backup" }, { id: "c", text: "nightly" }]);
    const body = await seedIndexedNote(db, { ownerId: u.id }, "notes", [{ id: "a", text: "deploy to prod, then backup" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "deploy only", [{ id: "a", text: "prod" }]);
    const r = await search(db, u.id, ["deploy", "prod", "backup"]);
    expect(idsOf(r).sort()).toEqual([split.id, body.id].sort());
    for (const row of r.rows) expect(row.termHits).toEqual([true, true, true]);
  });

  it("rank tiers: title equals the keywords joined by a space 0, starts with them 1, title holds every keyword 2, some 3, body only 4", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const equal = await seedIndexedNote(db, { ownerId: u.id }, "Release Notes", [{ id: "p", text: "x" }]);
    const starts = await seedIndexedNote(db, { ownerId: u.id }, "release notes 2026", [{ id: "p", text: "x" }]);
    const allInTitle = await seedIndexedNote(db, { ownerId: u.id }, "notes about the release", [{ id: "p", text: "x" }]);
    const someInTitle = await seedIndexedNote(db, { ownerId: u.id }, "release plan", [{ id: "p", text: "meeting notes" }]);
    const bodyOnly = await seedIndexedNote(db, { ownerId: u.id }, "misc", [{ id: "p", text: "release notes inside" }]);
    const r = await search(db, u.id, ["release", "notes"]);
    expect(idsOf(r)).toEqual([equal.id, starts.id, allInTitle.id, someInTitle.id, bodyOnly.id]);
    expect(r.rows.map(x => x.rank)).toEqual([0, 1, 2, 3, 4]);
    expect(r.rows.map(x => [x.titleHit, x.bodyHit])).toEqual([[true, false], [true, false], [true, false], [true, true], [false, true]]);
  });

  it("bodyOnly keeps only notes with a body hit among the same matches", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    await seedIndexedNote(db, { ownerId: u.id }, "alpha beta", [{ id: "p", text: "nothing" }]);
    const mixed = await seedIndexedNote(db, { ownerId: u.id }, "alpha", [{ id: "p", text: "beta" }]);
    const r = await search(db, u.id, ["alpha", "beta"], "all", { bodyOnly: true });
    expect(idsOf(r)).toEqual([mixed.id]);
  });

  it("CJK and Latin keywords mix; keywords are literal (% and _ are not wildcards)", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const hit = await seedIndexedNote(db, { ownerId: u.id }, "部署紀錄", [{ id: "p", text: "正式機 50%_off 備份完成" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "部署紀錄 2", [{ id: "p", text: "正式機 50xxoff" }]);
    expect(idsOf(await search(db, u.id, ["部署", "50%_off", "備份"]))).toEqual([hit.id]);
  });
});

describe("any mode", () => {
  it("at least one keyword; more keywords rank first (missing × 5 + tier); termHits says which", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const three = await seedIndexedNote(db, { ownerId: u.id }, "misc a", [{ id: "p", text: "red green blue" }]);
    const twoTitle = await seedIndexedNote(db, { ownerId: u.id }, "red green", [{ id: "p", text: "x" }]);
    const one = await seedIndexedNote(db, { ownerId: u.id }, "misc b", [{ id: "p", text: "only blue" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "none", [{ id: "p", text: "yellow" }]);
    const r = await search(db, u.id, ["red", "green", "blue"], "any");
    expect(idsOf(r)).toEqual([three.id, twoTitle.id, one.id]);
    expect(r.rows.map(x => x.rank)).toEqual([4, 5 + 2, 10 + 4]); // "red green": both keywords it has are in the title (tier 2)
    expect(r.rows.map(x => x.termHits)).toEqual([[true, true, true], [true, true, false], [false, false, true]]);
  });
});

describe("sections", () => {
  it("sections with more distinct keywords first, then document order; p is the earliest hit and ps every keyword's position", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedIndexedNote(db, { ownerId: u.id }, "doc", [
      { id: "h0", type: "heading", level: 2, text: "One" }, { id: "a", text: "only alpha here" },
      { id: "h1", type: "heading", level: 2, text: "Two" }, { id: "b", text: "beta then alpha" },
      { id: "h2", type: "heading", level: 2, text: "Three" }, { id: "c", text: "nothing" },
      { id: "h3", type: "heading", level: 2, text: "Four" }, { id: "d", text: "beta only" },
    ]);
    const r = await search(db, u.id, ["alpha", "beta"], "any");
    const m = groupMatchesByNote(r.matches).get(n.id)!;
    expect(m.map(x => x.section_id)).toEqual(["h1", "h0", "h3"]);
    const two = m[0]!;
    expect(two.ps!.every(p => p > 0)).toBe(true);
    expect(two.ps![1]!).toBeLessThan(two.ps![0]!); // "beta then alpha"
    expect(two.p).toBe(Math.min(...two.ps!));
    expect(m[1]!.ps![1]).toBe(0);
  });
});

describe("keyset pages and visibility", () => {
  it("pages through every match exactly once in rank order", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const n = await seedIndexedNote(db, { ownerId: u.id }, i % 2 === 0 ? `omega psi ${i}` : `n${i}`, [{ id: "p", text: i % 3 === 0 ? "omega" : "omega psi" }]);
      await at(db, n.id, `2026-03-0${i + 1}T00:00:00.000Z`);
      ids.push(n.id);
    }
    const seen: string[] = [];
    let after: SearchPageKey | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const r = await search(db, u.id, ["omega", "psi"], "any", { limit: 2, page: { after } });
      const page = r.rows.slice(0, 2);
      seen.push(...page.map(x => x.id));
      if (r.rows.length <= 2) break;
      const last = page.at(-1)!;
      after = { rank: last.rank, updatedAtKey: last.updatedAtKey!, id: last.id };
    }
    expect(seen.sort()).toEqual([...ids].sort());
    const full = await search(db, u.id, ["omega", "psi"], "any", { limit: 50, page: { after: null } });
    expect(idsOf(full).length).toBe(7);
  });

  it("visibility still comes only from the three-way union (owned, shared, group member)", async () => {
    const { db } = await freshDb();
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const own = await seedIndexedNote(db, { ownerId: a.id }, "x", [{ id: "p", text: "kilo lima" }]);
    const sharedNote = await seedIndexedNote(db, { ownerId: b.id }, "y", [{ id: "p", text: "kilo lima" }]);
    await seedShare(db, sharedNote.id, a.id, "viewer");
    const g = await seedGroup(db, `g-${Date.now()}`, [{ userId: c.id, role: "admin" }, { userId: a.id, role: "member" }]);
    const groupNote = await seedIndexedNote(db, { groupId: g.id }, "z", [{ id: "p", text: "kilo lima" }]);
    const hidden = await seedIndexedNote(db, { ownerId: c.id }, "w", [{ id: "p", text: "kilo lima" }]);
    const r = await search(db, a.id, ["kilo", "lima"]);
    expect(idsOf(r).sort()).toEqual([own.id, sharedNote.id, groupNote.id].sort());
    expect(idsOf(r)).not.toContain(hidden.id);
  });
});
