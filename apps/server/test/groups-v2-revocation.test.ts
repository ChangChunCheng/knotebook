/** "Stays connected" assertions always wait past the reverification deadline (an unresponsive reverification is only closed when the deadline expires). */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, NOTE_SCHEMA_VERSION, YDOC_FRAGMENT, type GroupRoleDto } from "@knotebook/shared";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";
import { seedRole } from "./group-helpers.js";
import { loadDoc } from "./copy-helpers.js";

const PASSWORD = "correct-horse-battery";

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

async function memberRoleId(session: HttpSession, groupId: string): Promise<string> {
  const res = await api(session, "GET", `/api/groups/${groupId}/roles`);
  expect(res.status).toBe(200);
  return (res.json as GroupRoleDto[]).find(r => r.builtin === "member")!.id;
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

describe("#175 revocation (group notes)", () => {
  it("removing a member: someone with access only through the group is closed (revoked) within 10 seconds; the admin's connection stays", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v1@example.com");
    const member = await user(ctx, "m-v1@example.com");
    const groupId = await makeGroup(admin.session, ["m-v1@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}/members/${member.id}`)).status).toBe(204);
    await waitFor("被移出的人被踢", 10_000, () => revoked(memberClient.closes));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(adminClient.closes).toEqual([]);
  });

  it("#240 removing a member with an uppercase :userId: someone with access only through the group is closed (revoked) within 10 seconds", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-r5@example.com");
    const member = await user(ctx, "m-r5@example.com");
    const groupId = await makeGroup(admin.session, ["m-r5@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");
    const memberClient = await member.session.connect(noteId);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}/members/${member.id.toUpperCase()}`)).status).toBe(204);
    await waitFor("被移出的人被踢", 10_000, () => revoked(memberClient.closes));
  });

  it("switching to a read-only custom role: member stays but becomes read-only (writes no longer reach the admin)", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v2@example.com");
    const member = await user(ctx, "m-v2@example.com");
    const groupId = await makeGroup(admin.session, ["m-v2@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");
    const reader = await seedRole(ctx.db, groupId, "Reader", { canRead: true });

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, member.id);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { roleId: reader })).status).toBe(200);
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    insertParagraph(memberClient.doc, "after-downgrade");
    await sleep(1_000);
    expect(text(adminClient.doc)).not.toContain("after-downgrade");
    expect(memberClient.closes).toEqual([]);
  });

  it("switching from a read-only custom role back to the built-in plain member: member stays and read-only is lifted (writes reach the admin)", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v3@example.com");
    const member = await user(ctx, "m-v3@example.com");
    const groupId = await makeGroup(admin.session, ["m-v3@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");
    const reader = await seedRole(ctx.db, groupId, "Reader", { canRead: true });
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { roleId: reader })).status).toBe(200);

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, member.id);
    const back = await memberRoleId(admin.session, groupId);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${member.id}`, { roleId: back })).status).toBe(200);
    await waitFor("member 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    insertParagraph(memberClient.doc, "after-upgrade");
    await waitFor("升級後的寫入傳到管理員那邊", 10_000, () => text(adminClient.doc).includes("after-upgrade"));
    expect(memberClient.closes).toEqual([]);
  });

  it("add member / rename / delete empty group: no connection is closed", async () => {
    // Only discriminates against wrongly closed connections: even if the implementation wrongly triggered reverification, these people keep access and wouldn't be closed,
    // so this test can't detect extra hook calls. That is guarded by the spy assertions in groups-members (add member) and groups-v2-delete (delete group).
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-v4@example.com");
    const member = await user(ctx, "m-v4@example.com");
    await user(ctx, "n-v4@example.com");
    const groupId = await makeGroup(admin.session, ["m-v4@example.com"]);
    const emptyGroupId = await makeGroup(admin.session, ["m-v4@example.com"], "Empty");
    const noteId = await createGroupNote(member.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    expect((await api(admin.session, "PUT", `/api/groups/${groupId}/members`, { email: "n-v4@example.com" })).status).toBe(200);
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}`, { name: "Renamed" })).status).toBe(200);
    expect((await api(admin.session, "DELETE", `/api/groups/${emptyGroupId}`, { mode: "delete" })).status).toBe(204);
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(adminClient.closes).toEqual([]);
    expect(memberClient.closes).toEqual([]);
  });
});

describe("#175 revocation on move", () => {
  it("personal -> group: someone with access only through a per-user share is closed (revoked) within 10 seconds; a share recipient who is also a member of the new group stays; the owner stays and can still write (writes reach another group member)", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-mv1@example.com");
    const sharedOnly = await user(ctx, "c-mv1@example.com");
    const sharedMember = await user(ctx, "d-mv1@example.com");
    const member = await user(ctx, "m-mv1@example.com");
    const groupId = await makeGroup(owner.session, ["d-mv1@example.com", "m-mv1@example.com"]);
    const { id: noteId } = await ctx.createNote(owner.id, "personal note");
    await ctx.share(noteId, sharedOnly.id, "editor");
    await ctx.share(noteId, sharedMember.id, "editor");

    const ownerClient = await owner.session.connect(noteId);
    const sharedOnlyClient = await sharedOnly.session.connect(noteId);
    const sharedMemberClient = await sharedMember.session.connect(noteId);
    expect((await api(owner.session, "POST", `/api/notes/${noteId}/move`, { groupId })).status).toBe(200);
    await waitFor("只靠逐人分享的人被踢", 10_000, () => revoked(sharedOnlyClient.closes));
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(ownerClient.closes).toEqual([]);
    expect(sharedMemberClient.closes).toEqual([]);

    const memberClient = await member.session.connect(noteId);
    insertParagraph(ownerClient.doc, "after-move");
    await waitFor("owner 移動後的寫入傳到群組成員那邊", 10_000, () => text(memberClient.doc).includes("after-move"));
    expect(ownerClient.closes).toEqual([]);
  });

  it("create-only role (can create, cannot edit) moving in: owner stays but becomes read-only after reverification - collab-token returns viewer and writes no longer reach the group admin", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-mv2@example.com");
    const owner = await user(ctx, "owner-mv2@example.com");
    const groupId = await makeGroup(admin.session, ["owner-mv2@example.com"]);
    const contributor = await seedRole(ctx.db, groupId, "Contributor", { canRead: true, canCreate: true });
    expect((await api(admin.session, "PATCH", `/api/groups/${groupId}/members/${owner.id}`, { roleId: contributor })).status).toBe(200);
    const { id: noteId } = await ctx.createNote(owner.id, "personal note");

    const ownerClient = await owner.session.connect(noteId);
    const synced = await armTokenSync(ctx, noteId, owner.id);
    const moved = await api(owner.session, "POST", `/api/notes/${noteId}/move`, { groupId });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ role: "viewer", permissions: { edit: false } });
    await waitFor("owner 那條連線完成重驗（setReadOnly 之後）", 10_000, synced);
    const token = await api(owner.session, "POST", `/api/notes/${noteId}/collab-token`, { noteSchemaVersion: NOTE_SCHEMA_VERSION });
    expect(token.status).toBe(200);
    expect((token.json as { role: string }).role).toBe("viewer");

    const adminClient = await admin.session.connect(noteId);
    insertParagraph(ownerClient.doc, "after-move-readonly");
    // Secondary assertion, not the verdict: a negative assertion after `sleep(1_000)` can pass falsely when propagation takes over a second (the positive tests in this file allow 10 seconds).
    // The verdict is carried by armTokenSync above (the owner's connection finished reverification) and collab-token returning `viewer`.
    await sleep(1_000);
    expect(text(adminClient.doc)).not.toContain("after-move-readonly");
    expect(ownerClient.closes).toEqual([]);
  });
});

describe("#175 copy", () => {
  it("source has an online user with unflushed edits -> copy takes a live fork and the copy contains that text; opening the copy with a provider right after copying shows the same content; the online user is not kicked", async () => {
    const ctx = await buildApp();
    const owner = await user(ctx, "owner-cp1@example.com");
    const { id: noteId } = await ctx.createNote(owner.id, "personal note");
    const ownerClient = await owner.session.connect(noteId);
    insertParagraph(ownerClient.doc, "live-unsaved-text");
    await waitFor("編輯到達 server 的 live doc", 5_000, () => text(ctx.collab.hocuspocus.documents.get(noteId)!).includes("live-unsaved-text"));
    // "Unflushed": onStoreDocument debounces 2 seconds, so note_states doesn't hold this text yet (and a row, if any, wouldn't contain it). This test relies on that window
    // (`STORE_DEBOUNCE_MS`; buildApp has no injection point); a single run takes about 0.5 s, roughly 4x margin on the 2 s window. If the store runs first, the precondition assertion on the next line fails
    // instead of silently passing without reaching the live fork.
    const persisted = await loadDoc(ctx.db, noteId);
    expect(persisted === null ? "" : text(persisted)).not.toContain("live-unsaved-text");

    const res = await api(owner.session, "POST", `/api/notes/${noteId}/copy`, {});
    expect(res.status).toBe(201);
    const copyId = (res.json as { id: string }).id;
    expect(text((await loadDoc(ctx.db, copyId))!)).toContain("live-unsaved-text");

    const copyClient = await owner.session.connect(copyId);
    expect(text(copyClient.doc)).toContain("live-unsaved-text");
    expect(text(copyClient.doc)).toBe(text(ctx.collab.hocuspocus.documents.get(noteId)!));
    expect(ownerClient.closes).toEqual([]);
  });
});

describe("#175 revocation on group delete", () => {
  it("transfer: a member with access only through the group is closed (revoked) within 10 seconds; transferTo's connection stays, collab-token returns role owner, writes are persisted", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-dg1@example.com");
    const member = await user(ctx, "m-dg1@example.com");
    const groupId = await makeGroup(admin.session, ["m-dg1@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    const adminSynced = await armTokenSync(ctx, noteId, admin.id);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}`, { mode: "transfer", transferTo: admin.id })).status).toBe(204);
    await waitFor("只靠群組取得存取的成員被踢", 10_000, () => revoked(memberClient.closes));
    // Pins the call surface "transferTo is also reverified" (without the `[transferTo]` batch this times out);
    // behaviourally equivalent otherwise: transferTo is the built-in admin and already writable, so writes would persist even without reverification.
    await waitFor("transferTo 那條連線完成重驗（setReadOnly 之後）", 10_000, adminSynced);
    await sleep(REVERIFY_DEADLINE_MS + 1_000);
    expect(adminClient.closes).toEqual([]);

    const token = await api(admin.session, "POST", `/api/notes/${noteId}/collab-token`, { noteSchemaVersion: NOTE_SCHEMA_VERSION });
    expect(token.status).toBe(200);
    expect((token.json as { role: string }).role).toBe("owner");

    insertParagraph(adminClient.doc, "after-transfer");
    // Persisted = onStoreDocument (2 second debounce) writes note_states; a read-only connection's updates are dropped by the server and never persist.
    const persistDeadline = Date.now() + 10_000;
    let persisted = "";
    while (Date.now() < persistDeadline && !persisted.includes("after-transfer")) {
      await sleep(100);
      const doc = await loadDoc(ctx.db, noteId);
      persisted = doc === null ? "" : text(doc);
    }
    expect(persisted).toContain("after-transfer");
    expect(adminClient.closes).toEqual([]);
  });

  it("delete all: connections on P0 get CLOSE(note-deleted) (not revoked)", async () => {
    const ctx = await buildApp();
    const admin = await user(ctx, "admin-dg2@example.com");
    const member = await user(ctx, "m-dg2@example.com");
    const groupId = await makeGroup(admin.session, ["m-dg2@example.com"]);
    const noteId = await createGroupNote(member.session, groupId, "crew note");

    const adminClient = await admin.session.connect(noteId);
    const memberClient = await member.session.connect(noteId);
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}`, { mode: "delete" })).status).toBe(204);
    await waitFor("管理員那條收到 CLOSE(note-deleted)", 10_000, () => adminClient.closes.some(c => c.reason === COLLAB_CLOSE_NOTE_DELETED));
    await waitFor("成員那條收到 CLOSE(note-deleted)", 10_000, () => memberClient.closes.some(c => c.reason === COLLAB_CLOSE_NOTE_DELETED));
    expect(revoked(adminClient.closes)).toBe(false);
    expect(revoked(memberClient.closes)).toBe(false);
    expect(ctx.collab.connectionsOfNote(noteId).size).toBe(0);
  });

  it("delete all: connections on notes that joined the group after the gate (L \\ P0) are closed within 10 seconds after commit with reason revoked, not note-deleted (a known cost)", async () => {
    // `buildCollabTestApp` has no `groupTestHook` injection point, so "after the gates, before the transaction" is reached by wrapping the real `beforeNoteDeleted`:
    // the route fetches P0 and awaits `beforeNoteDeleted` for every note in P0 (Promise.allSettled) before entering the transaction; inside the wrapper, once the real gates are done,
    // the note is created and connected - the same window as `group-delete-gated` (after P0, before the transaction). `gatedIds` confirms the new note is not in P0.
    const gatedIds: string[] = [];
    const holder: { onGated: (() => Promise<void>) | null } = { onGated: null };
    const ctx = await buildCollabTestApp({
      collabHooks: (server, log) => {
        const real = createCollabHooks(server, log);
        return {
          ...real,
          async beforeNoteDeleted(noteId: string) {
            gatedIds.push(noteId);
            const gate = await real.beforeNoteDeleted(noteId);
            const fire = holder.onGated;
            holder.onGated = null;
            if (fire) await fire();
            return gate;
          },
        };
      },
    });
    const admin = await user(ctx, "admin-dg3@example.com");
    const member = await user(ctx, "m-dg3@example.com");
    const groupId = await makeGroup(admin.session, ["m-dg3@example.com"]);
    const p0NoteId = await createGroupNote(admin.session, groupId, "p0 note");

    const late: { noteId: string | null; client: Awaited<ReturnType<HttpSession["connect"]>> | null } = { noteId: null, client: null };
    holder.onGated = async () => {
      late.noteId = await createGroupNote(member.session, groupId, "late note");
      late.client = await member.session.connect(late.noteId);
    };
    expect((await api(admin.session, "DELETE", `/api/groups/${groupId}`, { mode: "delete" })).status).toBe(204);
    expect(late.noteId).not.toBeNull();
    expect(gatedIds).toEqual([p0NoteId]);
    expect((await api(member.session, "GET", `/api/notes/${late.noteId!}`)).status).toBe(404);

    const lateClient = late.client!;
    await waitFor("L \\ P0 上的連線在 commit 後被關（revoked）", 10_000, () => revoked(lateClient.closes));
    await sleep(1_000);
    expect(lateClient.closes.some(c => c.reason === COLLAB_CLOSE_NOTE_DELETED)).toBe(false);
  });
});
