// Member fields: whom a handle or user:<id> resolves to when written, how stored members read back, and the lookup endpoint.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { YDOC_FRAGMENT, type KnowledgeMembersDto } from "@knotebook/shared";
import { knowledgeFieldDefs, users } from "../src/db/schema.js";
import { knowledgeInfoById } from "../src/notes/editing/knowledge-write.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { callTool, seedBlocks, type ToolCallResult } from "./bulk-transfer-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";

const K1 = "k_00000001";
const K2 = "k_00000002";
const K3 = "k_00000003";
const comment = (lines: string[]) => `<!-- knotebook:knowledge\n${lines.join("\n")}\n-->`;
const KH = (id: string, text: string, knowledgeId: string, owner?: string) => ({
  id,
  type: "heading",
  props: { level: 2, knowledgeId, knowledgeWhen: "w", ...(owner !== undefined ? { knowledgeCustom: JSON.stringify({ owner }) } : {}) },
  content: text,
});
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });

interface Ignored { heading: string; key: string; value: string; reason: string }
interface People { alice: SeededUser; bob: SeededUser; carol: SeededUser; dave: SeededUser; erin: SeededUser }
const ok = (r: ToolCallResult): Record<string, unknown> => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent;
};
const ignoredOf = (r: ToolCallResult): Ignored[] => (ok(r).knowledge as { ignored: Ignored[] } | undefined)?.ignored ?? [];

/** alice, bob, dave and erin share a group; carol knows none of them. alice owns the note and writes. */
async function setup(blocks: (p: People) => unknown[] = () => [P("p0", "intro")]) {
  const ctx = await buildCollabTestApp();
  const people: People = {
    alice: await seedUser(ctx.db, { displayName: "Alice" }),
    bob: await seedUser(ctx.db, { displayName: "Bob" }),
    carol: await seedUser(ctx.db, { displayName: "Carol" }),
    dave: await seedUser(ctx.db, { displayName: "Dave" }),
    erin: await seedUser(ctx.db, { displayName: "Erin" }),
  };
  const { alice, bob, dave, erin } = people;
  await seedGroup(ctx.db, "Team", [
    { userId: alice.id, role: "admin" },
    { userId: bob.id, role: "member" },
    { userId: dave.id, role: "member" },
    { userId: erin.id, role: "member" },
  ]);
  await ctx.db.insert(knowledgeFieldDefs).values({ kind: "field", fieldRef: "x-owner", key: "owner", type: "member", originKind: "site" });
  const pat = await seedTokenForUser(ctx.db, alice.id, "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: alice.id }, { title: "Notes" });
  await seedBlocks(ctx.db, note.id, blocks(people));
  const call = (name: string, args: Record<string, unknown>) => callTool(ctx.app, pat.token, name, args);
  const section = async (id: string) => (ok(await call("read_note_section", { note_id: note.id, section_id: id })) as { section: { markdown: string; fingerprint: string } }).section;
  const replaceSection = async (id: string, markdown: (current: string) => string) => {
    const sec = await section(id);
    return call("edit_note", { note_id: note.id, op: "replace_section", section_id: id, if_match: sec.fingerprint, markdown: markdown(sec.markdown) });
  };
  const wholeFingerprint = async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content`, headers: { authorization: `Bearer ${pat.token}` } });
    return (res.json() as { fingerprint: string }).fingerprint;
  };
  const infos = async () => knowledgeInfoById((await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id)).doc.getXmlFragment(YDOC_FRAGMENT));
  return { ctx, ...people, pat, note, call, section, replaceSection, wholeFingerprint, infos };
}
type S = Awaited<ReturnType<typeof setup>>;

describe("writing a member field", () => {
  it("a member is written by handle within the writer's reach and stored as a user id", async () => {
    const s = await setup(() => [KH("hA", "A", K1), P("a1", "body")]);
    const r = await s.replaceSection("hA", () => `## A\n${comment([`id: ${K1}`, "when: w", `x-owner: ${s.bob.handle.toUpperCase()}`])}\n\nbody\n`);
    expect(ignoredOf(r)).toEqual([]);
    expect((await s.infos()).get(K1)?.custom).toEqual({ owner: s.bob.id });
    expect((await s.section("hA")).markdown).toContain(`x-owner: ${s.bob.handle}\n`);
    await s.ctx.destroy();
  });

  it("a stranger, an unknown handle and a user: reference outside reach are all unresolved members", async () => {
    const s = await setup(p => [KH("hA", "A", K1, p.bob.id), P("a1", "a"), KH("hB", "B", K2, p.bob.id), P("b1", "b"), KH("hC", "C", K3, p.bob.id), P("c1", "c")]);
    const written = [s.carol.handle, "nobody-here", `user:${s.carol.id}`];
    const markdown = ["A", "B", "C"].map((h, i) => `## ${h}\n${comment([`id: ${[K1, K2, K3][i]}`, "when: w", `x-owner: ${written[i]}`])}\n\n${h.toLowerCase()}\n`).join("\n");
    const r = await s.call("edit_note", { note_id: s.note.id, op: "replace_all", if_match: await s.wholeFingerprint(), markdown });
    expect(ignoredOf(r)).toEqual([
      { heading: "A", key: "x-owner", value: s.carol.handle, reason: "unresolved_member" },
      { heading: "B", key: "x-owner", value: "nobody-here", reason: "unresolved_member" },
      { heading: "C", key: "x-owner", value: `user:${s.carol.id}`, reason: "unresolved_member" },
    ]);
    const after = await s.infos();
    for (const id of [K1, K2, K3]) expect(after.get(id)?.custom, id).toEqual({ owner: s.bob.id });
    await s.ctx.destroy();
  });

  it("the writer can name themself, and a group mate by user:<id> in a new note", async () => {
    const s = await setup(() => [KH("hA", "A", K1), P("a1", "a")]);
    const r = await s.replaceSection("hA", () => `## A\n${comment([`id: ${K1}`, "when: w", `x-owner: ${s.alice.handle}`])}\n\na\n`);
    expect(ignoredOf(r)).toEqual([]);
    expect((await s.infos()).get(K1)?.custom).toEqual({ owner: s.alice.id });
    const created = await s.call("create_note", { title: "Mine", content: `## M\n${comment(["when: w", `x-owner: user:${s.bob.id.toUpperCase()}`])}\n\nm\n` });
    expect(ignoredOf(created)).toEqual([]);
    const id = (ok(created).note as { id: string }).id;
    const doc = (await loadNoteDoc({ db: s.ctx.db, collab: s.ctx.collab }, id)).doc;
    expect([...knowledgeInfoById(doc.getXmlFragment(YDOC_FRAGMENT)).values()].map(i => i.custom)).toEqual([{ owner: s.bob.id }]);
    await s.ctx.destroy();
  });

  it("a stored member who was later disabled is written back unchanged without being ignored, but can't be newly written", async () => {
    const s = await setup(p => [KH("hA", "A", K1, p.dave.id), P("a1", "a"), KH("hB", "B", K2), P("b1", "b")]);
    await s.ctx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, s.dave.id));
    expect((await s.section("hA")).markdown).toContain(`x-owner: ${s.dave.handle}\n`);
    const back = await s.replaceSection("hA", md => md.replace("\na\n", "\na changed\n"));
    expect(ignoredOf(back)).toEqual([]);
    expect((await s.infos()).get(K1)?.custom).toEqual({ owner: s.dave.id });
    const fresh = await s.replaceSection("hB", () => `## B\n${comment([`id: ${K2}`, "when: w", `x-owner: ${s.dave.handle}`])}\n\nb\n`);
    expect(ignoredOf(fresh)).toEqual([{ heading: "B", key: "x-owner", value: s.dave.handle, reason: "unresolved_member" }]);
    expect((await s.infos()).get(K2)?.custom).toEqual({});
    await s.ctx.destroy();
  });

  it("a deleted member is exported as user:<id> and written back unchanged", async () => {
    const s = await setup(p => [KH("hA", "A", K1, p.erin.id), P("a1", "a")]);
    await s.ctx.db.delete(users).where(eq(users.id, s.erin.id));
    expect((await s.section("hA")).markdown).toContain(`x-owner: user:${s.erin.id}\n`);
    const back = await s.replaceSection("hA", md => md.replace("\na\n", "\na changed\n"));
    expect(ignoredOf(back)).toEqual([]);
    expect((await s.infos()).get(K1)?.custom).toEqual({ owner: s.erin.id });
    await s.ctx.destroy();
  });
});

describe("POST /api/knowledge/members", () => {
  const post = async (s: S, userId: string, payload: Record<string, unknown>) =>
    s.ctx.app.inject({ method: "POST", url: "/api/knowledge/members", cookies: await cookieOf(userId), payload });

  it("the members endpoint resolves tokens only within reach but names any stored id", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, s.dave.id));
    const res = await post(s, s.alice.id, {
      noteId: s.note.id,
      tokens: [s.bob.handle, s.carol.handle, s.dave.handle, "nobody-here", `USER:${s.bob.id}`, `user:${s.carol.id}`, "user:not-a-uuid", s.alice.handle],
      ids: [s.carol.id, s.dave.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid"],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json() as KnowledgeMembersDto).toEqual({
      byId: [
        { id: s.carol.id, handle: s.carol.handle, displayName: "Carol" },
        { id: s.dave.id, handle: s.dave.handle, displayName: "Dave" },
      ],
      byToken: [
        { token: s.bob.handle, id: s.bob.id },
        { token: `user:${s.bob.id}`, id: s.bob.id },
        { token: s.alice.handle, id: s.alice.id },
      ],
    });
    expect(res.body).not.toContain("email");
    expect(res.body).not.toContain("@example.com");
    await s.ctx.destroy();
  });

  it("someone who can't read the note gets 404 from the members endpoint, the same as for a note that doesn't exist", async () => {
    const s = await setup();
    const hidden = await post(s, s.carol.id, { noteId: s.note.id, tokens: [s.bob.handle] });
    const missing = await post(s, s.carol.id, { noteId: "00000000-0000-4000-8000-000000000000", tokens: [s.bob.handle] });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    await s.ctx.destroy();
  });

  it("takes a session only, and refuses a body over the list limits", async () => {
    const s = await setup();
    const bearer = await s.ctx.app.inject({ method: "POST", url: "/api/knowledge/members", headers: { authorization: `Bearer ${s.pat.token}` }, payload: { noteId: s.note.id } });
    expect(bearer.statusCode).toBe(401);
    const tooMany = await post(s, s.alice.id, { noteId: s.note.id, tokens: Array.from({ length: 101 }, (_, i) => `h${i}`) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe("invalid_body");
    await s.ctx.destroy();
  });
});
