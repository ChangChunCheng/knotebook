/**
 * Custom roles are created with `POST /api/groups/:id/roles` (read is always true), not `seedRole`, whose default is `canRead: false`.
 *
 * Wait and negative-assertion policy:
 * - "Reverification happened" always uses `armTokenSync`'s deterministic wait (callback in the server's `onTokenSync` `finally`, after `setReadOnly`);
 *   if revocation isn't triggered the `waitFor` times out -> red, never falsely green.
 * - "The write didn't propagate" and "no reverification" are negative assertions and can only use a fixed sleep. The sleep of the delete-flag-only test is
 *   `REVERIFY_DEADLINE_MS + 1_000` (6 seconds): a wrongly triggered reverification with an unresponsive client only closes the connection at the deadline (5 seconds),
 *   so the window has to outlast it. The edit-flag and create-only tests don't depend on the window length: `serverConn(...).readOnly` is asserted deterministically
 *   and the sleep stays only as insurance, at the 500 ms used in `collab-auth.test.ts`.
 * - No assertion depends on the collab server's store debounce (`STORE_DEBOUNCE_MS`): propagation is an immediate broadcast. "Content is on the server" in the
 *   create-only test is judged from the doc A receives on a fresh connect (creating with content writes it into the server's doc before the 201; this doesn't claim
 *   it went through the store - the doc may still be in memory before A connects).
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, NOTE_SCHEMA_VERSION, YDOC_FRAGMENT, type GroupMemberDto, type GroupRoleDto, type GroupRoleFlags } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";

const PASSWORD = "correct-horse-battery";
const NONE: GroupRoleFlags = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
// Negative wait for the delete-flag-only test: past the reverification deadline (an unresponsive reverification is only closed at the deadline) plus 1 second.
const NEGATIVE_WAIT_MS = REVERIFY_DEADLINE_MS + 1_000;
// Negative wait for tests that assert `serverConn(...).readOnly` deterministically: only needs to outlast propagation (same as collab-auth.test.ts).
const SHORT_NEGATIVE_WAIT_MS = 500;

function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

const text = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();
const revoked = (closes: Array<{ reason: string }>): boolean => closes.some(c => c.reason === COLLAB_CLOSE_REVOKED);

async function api(session: HttpSession, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await session.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await res.text();
  return { status: res.status, json: raw ? JSON.parse(raw) : null };
}

async function user(ctx: CollabTestCtx, email: string): Promise<{ id: string; session: HttpSession }> {
  const u = await ctx.createUser({ email, password: PASSWORD });
  return { id: u.id, session: await ctx.loginAs(email, PASSWORD) };
}

async function makeGroup(creator: HttpSession, members: string[], name = "Crew"): Promise<string> {
  const g = await api(creator, "POST", "/api/groups", { name });
  expect(g.status).toBe(201);
  const id = (g.json as { id: string }).id;
  for (const email of members) expect((await api(creator, "PUT", `/api/groups/${id}/members`, { email })).status).toBe(200);
  return id;
}

async function createGroupNote(session: HttpSession, groupId: string, title: string): Promise<string> {
  const res = await api(session, "POST", "/api/notes", { groupId, title });
  expect(res.status).toBe(201);
  return (res.json as { id: string }).id;
}

async function createRole(admin: HttpSession, groupId: string, name: string, permissions: GroupRoleFlags): Promise<string> {
  const res = await api(admin, "POST", `/api/groups/${groupId}/roles`, { name, permissions });
  expect(res.status).toBe(201);
  return (res.json as GroupRoleDto).id;
}

async function assignRole(admin: HttpSession, groupId: string, userId: string, roleId: string): Promise<void> {
  expect((await api(admin, "PATCH", `/api/groups/${groupId}/members/${userId}`, { roleId })).status).toBe(200);
}

/**
 * Register before triggering reverification: resolves true when `userId`'s connection on this note finishes its next `onTokenSync`.
 * `CollabServer.onNextTokenSync` callbacks are dispatched in `onTokenSync`'s `finally`, after `handle.setReadOnly(...)`
 * (`onTokenSync` in `collab/server.ts`) - a deterministic wait that replaces a fixed sleep.
 */
async function armTokenSync(ctx: CollabTestCtx, noteId: string, userId: string): Promise<() => boolean> {
  await waitFor("連線已登記進索引", 5_000, () => [...ctx.collab.connectionsOfNote(noteId)].some(c => c.userId === userId));
  const handle = [...ctx.collab.connectionsOfNote(noteId)].find(c => c.userId === userId)!;
  let synced = false;
  ctx.collab.onNextTokenSync(handle, () => {
    synced = true;
  });
  return () => synced;
}

function serverConn(ctx: CollabTestCtx, noteId: string, userId: string) {
  const handle = [...ctx.collab.connectionsOfNote(noteId)].find(c => c.userId === userId)!;
  const conn = ctx.collab.hocuspocus.documents.get(noteId)?.getConnections().find(c => c.socketId === handle.socketId);
  if (!conn) throw new Error("找不到 server 端連線");
  return conn;
}

describe("#175 role change revocation (real connections)", () => {
  it("changing the role's edit flag to false: holder stays but becomes read-only (writes no longer reach the admin)", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r1@example.com");
    const member = await user(ctx, "m-r1@example.com");
    const groupId = await makeGroup(admin.session, ["m-r1@example.com"]);
    const writers = await createRole(admin.session, groupId, "Writers", { ...NONE, edit: true });
    await assignRole(admin.session, groupId, member.id, writers);
    const noteId = await createGroupNote(admin.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    // Positive control: before the role change the member's write propagates (actual propagation time on this connection pair, the reference for the negative sleep).
    insertParagraph(memberClient.doc, "before-downgrade");
    await waitFor("改角色前的寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("before-downgrade"));

    const synced = await armTokenSync(ctx, noteId, member.id);
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(false);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/roles/${writers}`, { permissions: NONE })).status).toBe(200);
    // Primary check: if the PATCH route doesn't call onGroupAccessChanged there is no reverification and this times out -> red.
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(true);
    insertParagraph(memberClient.doc, "after-downgrade");
    // Insurance sleep for the negative assertion (see header): if read-only didn't take effect, this write would arrive within waitFor's polling interval like the positive control above.
    await sleep(SHORT_NEGATIVE_WAIT_MS);
    expect(text(adminClient.doc)).not.toContain("after-downgrade");
    expect(memberClient.closes).toEqual([]);
    expect(revoked(memberClient.closes)).toBe(false);
  });

  it("deleting the custom role Readers (read-only): holder moves to the built-in plain member, stays, and read-only is lifted (writes reach the admin)", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r2@example.com");
    const member = await user(ctx, "m-r2@example.com");
    const groupId = await makeGroup(admin.session, ["m-r2@example.com"]);
    const readers = await createRole(admin.session, groupId, "Readers", NONE);
    await assignRole(admin.session, groupId, member.id, readers);
    const noteId = await createGroupNote(admin.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, member.id);
    // Deterministic: before the delete the server-side connection is read-only. No "write once as control": a dropped update would leave later writes missing their dependency on the admin side.
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(true);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}/roles/${readers}`)).status).toBe(204);
    // Primary check: if the DELETE route doesn't call onGroupAccessChanged the connection doesn't reverify and stays read-only; this times out -> red.
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(false);
    insertParagraph(memberClient.doc, "after-role-delete");
    await waitFor("解除唯讀後的寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("after-role-delete"));
    expect(memberClient.closes).toEqual([]);
    const members = await api(admin.session, "GET", `/api/groups/${groupId}/members`);
    expect((members.json as GroupMemberDto[]).find(m => m.userId === member.id)?.builtin).toBe("member");
  });

  it("changing only the delete flag (read/edit unchanged): no reverification, the connection stays and can still write", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r3@example.com");
    const member = await user(ctx, "m-r3@example.com");
    const groupId = await makeGroup(admin.session, ["m-r3@example.com"]);
    const writers = await createRole(admin.session, groupId, "Writers", { ...NONE, edit: true });
    await assignRole(admin.session, groupId, member.id, writers);
    const noteId = await createGroupNote(admin.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, member.id);
    const res = await api(admin.session, "PATCH", `/api/groups/${groupId}/roles/${writers}`, { permissions: { ...NONE, edit: true, delete: true } });
    expect(res.status).toBe(200);
    expect((res.json as GroupRoleDto).permissions.delete).toBe(true);
    // "No reverification" is a negative assertion and can only use a sleep (see header): a wrongly triggered reverification is a short token round trip, far under 6 seconds.
    await sleep(NEGATIVE_WAIT_MS);
    expect(synced()).toBe(false);
    expect(memberClient.closes).toEqual([]);
    insertParagraph(memberClient.doc, "still-writable");
    await waitFor("仍可寫：寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("still-writable"));
  });

  it("create-only role creates a group note with content (allowed, contributor shape): 201 viewer, content present, later writes don't propagate", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r4@example.com");
    const member = await user(ctx, "m-r4@example.com");
    const groupId = await makeGroup(admin.session, ["m-r4@example.com"]);
    const contributors = await createRole(admin.session, groupId, "Contributors", { ...NONE, create: true });
    await assignRole(admin.session, groupId, member.id, contributors);

    // The cookie session goes through `authenticateAny("notes:write")`; buildCollabTestApp has the collab component, so the deployment gate lets content through.
    const created = await api(member.session, "POST", "/api/notes", { groupId, title: "Pitch", content: "contributed-text" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ role: "viewer", groupId, ownerId: null, permissions: { read: true, edit: false } });
    const noteId = (created.json as { id: string }).id;
    const token = await api(member.session, "POST", `/api/notes/${noteId}/collab-token`, { noteSchemaVersion: NOTE_SCHEMA_VERSION });
    expect((token.json as { role: string }).role).toBe("viewer");

    const adminClient = await admin.session.connect(noteId);
    expect(text(adminClient.doc)).toContain("contributed-text");
    // Positive control: A's (built-in admin, can edit) write reaches the member - actual propagation time on this connection pair.
    const memberClient = await member.session.connect(noteId);
    insertParagraph(adminClient.doc, "admin-edit");
    await waitFor("管理員的寫入傳到 member 那邊", 10_000, () => text(memberClient.doc).includes("admin-edit"));

    insertParagraph(memberClient.doc, "after-create");
    // Deterministic: the member is read-only on the server from the moment it connects (collab-token role is viewer, asserted above); the sleep is only insurance (see header).
    expect(serverConn(ctx, noteId, member.id).readOnly).toBe(true);
    await sleep(SHORT_NEGATIVE_WAIT_MS);
    expect(text(adminClient.doc)).not.toContain("after-create");
    expect(memberClient.closes).toEqual([]);
  });
});
