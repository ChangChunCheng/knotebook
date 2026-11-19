import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { hashToken } from "../src/auth/api-token.js";
import type { IssueBulkTransferTokenSeam } from "../src/auth/tx/issue-bulk-transfer-token.js";
import { loadConfig } from "../src/config.js";
import { apiTokens, transferTokens } from "../src/db/schema.js";
import { FOLDER_GROUP_NOT_FOUND_MESSAGE, FOLDER_NOT_FOUND_MESSAGE } from "../src/mcp/folder-messages.js";
import {
  BULK_NEXT_RO,
  BULK_NEXT_RW,
  BULK_RANGE_AMBIGUOUS_MESSAGE,
  OPEN_NOTES_AS_FILES_DESCRIPTION_RO,
  OPEN_NOTES_AS_FILES_DESCRIPTION_RW,
  TOO_MANY_BULK_TOKENS_MESSAGE,
  bulkCurls,
} from "../src/mcp/tools/open-notes-as-files.js";
import { REVOKED_MESSAGE } from "../src/mcp/tools/create-transfer-token.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedUser, setMemberRole, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { INITIALIZE, mcpPost, rpc } from "./mcp-helpers.js";
import { expireToken, issueDirect } from "./transfer-helpers.js";
import { callTool, exportRaw, issueBulkDirect, liveMarkdown, seedMd } from "./bulk-transfer-helpers.js";
import { readTarGz } from "./tar-read.js";

const ORIGIN = "https://kb.example.test:8443";
const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: "a".repeat(64), PUBLIC_URL: `${ORIGIN}/` });
const TOOL = "open_notes_as_files";
const RO = "notes:read" as const;
const RW = "notes:read notes:write" as const;
const RWMD = "notes:read notes:write notes:move notes:delete" as const;

async function rowOf(db: Parameters<typeof seedUser>[0], token: string) {
  const [r] = await db.select().from(transferTokens).where(eq(transferTokens.tokenHash, hashToken(token)));
  return r;
}
async function bulkCount(db: Parameters<typeof seedUser>[0], parentId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transferTokens)
    .where(sql`${transferTokens.parentTokenId} = ${parentId} and ${transferTokens.purpose} = 'bulk'`);
  return r!.n;
}
async function toolList(app: Parameters<typeof mcpPost>[0], opts: { token?: string; cookie?: string }) {
  const res = await mcpPost(app, rpc("tools/list"), opts);
  expect(res.statusCode).toBe(200);
  return res.json().result.tools as Array<{
    name: string; description: string; inputSchema: { properties?: Record<string, unknown>; additionalProperties?: unknown }; outputSchema?: { properties?: Record<string, unknown> };
  }>;
}

describe("five scopes and access stored in the DB", () => {
  it("{} -> all, space personal/shared, group_id (uppercase input stored lowercase), folder_id; note_id NULL, purpose bulk", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RO);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const f = await seedFolder(ctx.db, { personal: u.id });
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{}, { kind: "all" }],
      [{ space: "personal" }, { kind: "personal" }],
      [{ space: "shared" }, { kind: "shared" }],
      [{ group_id: g.id.toUpperCase() }, { kind: "group", groupId: g.id }],
      [{ folder_id: f.id.toUpperCase() }, { kind: "folder", folderId: f.id }],
    ];
    const extra = await seedTokenForUser(ctx.db, u.id, RO);
    for (const [k, [args, range]] of cases.entries()) {
      const tok = k < 3 ? token : extra.token; // each parent credential allows at most 3
      const r = await callTool(ctx.app, tok, TOOL, args);
      expect(r.isError, JSON.stringify(args)).toBeUndefined();
      const row = await rowOf(ctx.db, r.structuredContent.token as string);
      expect(row, JSON.stringify(args)).toMatchObject({ purpose: "bulk", noteId: null, access: "read", range });
    }
  });

  it("access: a read-only parent credential -> read, read-write -> write, read-write-move-delete -> write", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    for (const [scope, want] of [[RO, "read"], [RW, "write"], [RWMD, "write"]] as const) {
      const { token } = await seedTokenForUser(ctx.db, u.id, scope);
      const r = await callTool(ctx.app, token, TOOL, {});
      expect(r.structuredContent.access, scope).toBe(want);
      expect((await rowOf(ctx.db, r.structuredContent.token as string))?.access, scope).toBe(want);
    }
  });
});

describe("at most one range", () => {
  it("every pair and all three given -> invalid_body + BULK_RANGE_AMBIGUOUS_MESSAGE, zero rows", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, RO);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const f = await seedFolder(ctx.db, { personal: u.id });
    for (const args of [
      { space: "personal", group_id: g.id },
      { space: "shared", folder_id: f.id },
      { group_id: g.id, folder_id: f.id },
      { space: "personal", group_id: g.id, folder_id: f.id },
    ]) {
      const r = await callTool(ctx.app, token, TOOL, args);
      expect(r.structuredContent, JSON.stringify(args)).toEqual({ code: "invalid_body", message: BULK_RANGE_AMBIGUOUS_MESSAGE });
    }
    expect(await bulkCount(ctx.db, tokenId)).toBe(0);
  });
});

describe("group_id needs can_read", () => {
  it("non-member, a canRead:false role, random uuid -> group_not_found byte-identical; a create-only role -> success", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RO);
    const notMine = await seedGroup(ctx.db, "N", [{ userId: other.id, role: "admin" }]);
    const noRead = await seedGroup(ctx.db, "R", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, noRead.id, u.id, await seedRole(ctx.db, noRead.id, "blind", { canRead: false }));
    const results = [];
    for (const gid of [notMine.id, noRead.id, randomUUID()]) results.push((await callTool(ctx.app, token, TOOL, { group_id: gid })).structuredContent);
    for (const sc of results) expect(sc).toEqual({ code: "group_not_found", message: FOLDER_GROUP_NOT_FOUND_MESSAGE });
    expect(JSON.stringify(results[1])).toBe(JSON.stringify(results[0]));
    expect(JSON.stringify(results[2])).toBe(JSON.stringify(results[0]));
    const createOnly = await seedGroup(ctx.db, "C", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, createOnly.id, u.id, await seedRole(ctx.db, createOnly.id, "co", { canRead: true, canCreate: true }));
    expect((await callTool(ctx.app, token, TOOL, { group_id: createOnly.id })).isError).toBeUndefined();
  });
});

describe("an invisible folder_id -> not_found", () => {
  it("another person's personal folder and a random uuid -> not_found + FOLDER_NOT_FOUND_MESSAGE, byte-identical to rename_folder's error for the same uuid; one's own shared folder and a readable group's folder -> success", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RW);
    const theirs = await seedFolder(ctx.db, { personal: other.id });
    for (const fid of [theirs.id, randomUUID()]) {
      const mine = (await callTool(ctx.app, token, TOOL, { folder_id: fid })).structuredContent;
      expect(mine).toEqual({ code: "not_found", message: FOLDER_NOT_FOUND_MESSAGE });
      const rename = (await callTool(ctx.app, token, "rename_folder", { folder_id: fid, name: "x" })).structuredContent;
      expect(JSON.stringify(mine)).toBe(JSON.stringify(rename));
    }
    const sharedF = await seedFolder(ctx.db, { shared: u.id });
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const groupF = await seedFolder(ctx.db, { group: g.id });
    for (const fid of [sharedF.id, groupF.id]) expect((await callTool(ctx.app, token, TOOL, { folder_id: fid })).isError).toBeUndefined();
  });
});

describe("each parent credential has at most 3 unexpired ones", () => {
  it("3 succeed, the 4th is too_many_requests; after one expires the 4th succeeds; another parent credential is unaffected; upload/download credentials don't take a slot", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RW);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await callTool(ctx.app, a.token, TOOL, {});
      expect(r.isError, `#${i + 1}`).toBeUndefined();
      ids.push((await rowOf(ctx.db, r.structuredContent.token as string))!.id);
    }
    expect((await callTool(ctx.app, a.token, TOOL, {})).structuredContent).toEqual({ code: "too_many_requests", message: TOO_MANY_BULK_TOKENS_MESSAGE });
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(3);
    await expireToken(ctx.db, ids[0]!);
    expect((await callTool(ctx.app, a.token, TOOL, {})).isError).toBeUndefined();
    const b = await seedTokenForUser(ctx.db, u.id, RW);
    expect((await callTool(ctx.app, b.token, TOOL, {})).isError).toBeUndefined();
    const c = await seedTokenForUser(ctx.db, u.id, RW);
    const note = await seedNote(ctx.db, { ownerId: u.id });
    for (let i = 0; i < 5; i++) await issueDirect(ctx.db, c.tokenId, note.id, i % 2 === 0 ? "upload" : "download");
    for (let i = 0; i < 3; i++) expect((await callTool(ctx.app, c.token, TOOL, {})).isError, `c#${i + 1}`).toBeUndefined();
  });
});

describe("TTL", () => {
  it("expiresAt - DB now is within [29:50, 30:10]; a parent credential expiring in 5 minutes -> capped at the parent's expiry", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    const dbNow = async () => new Date((await ctx.db.execute<{ now: string }>(sql`select now()::text as now`)).rows[0]!.now).getTime();
    const before = await dbNow();
    const r = await callTool(ctx.app, a.token, TOOL, {});
    const after = await dbNow();
    const exp = new Date(r.structuredContent.expiresAt as string).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 30 * 60_000 - 10_000);
    expect(exp).toBeLessThanOrEqual(after + 30 * 60_000 + 10_000);
    const b = await seedTokenForUser(ctx.db, u.id, RO);
    await ctx.db.update(apiTokens).set({ accessExpiresAt: sql`now() + interval '5 minutes'` }).where(eq(apiTokens.id, b.tokenId));
    const [p] = await ctx.db.select({ e: apiTokens.accessExpiresAt }).from(apiTokens).where(eq(apiTokens.id, b.tokenId));
    const r2 = await callTool(ctx.app, b.token, TOOL, {});
    expect(r2.isError).toBeUndefined();
    expect(new Date(r2.structuredContent.expiresAt as string).getTime()).toBe(p!.e!.getTime());
  });
});

describe("registration (either-or by canWrite)", () => {
  it("(a) session has none (b) no collab + read-write token has none (c) read-only -> RO description, read-write / read-write-move-delete -> RW description; the RW outputSchema has one more property, `write` (d) properties are exactly three keys, additionalProperties false", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const cookie = (await cookieOf(u.id))[SESSION_COOKIE]!;
    expect((await toolList(ctx.app, { cookie })).map(t => t.name)).not.toContain(TOOL);
    const OUT_RO = ["access", "expiresAt", "export", "next", "note", "revoke", "token"];
    for (const [scope, desc, out] of [
      [RO, OPEN_NOTES_AS_FILES_DESCRIPTION_RO, OUT_RO],
      [RW, OPEN_NOTES_AS_FILES_DESCRIPTION_RW, [...OUT_RO, "write"].sort()],
      [RWMD, OPEN_NOTES_AS_FILES_DESCRIPTION_RW, [...OUT_RO, "write"].sort()],
    ] as const) {
      const { token } = await seedTokenForUser(ctx.db, u.id, scope);
      const tool = (await toolList(ctx.app, { token })).find(t => t.name === TOOL);
      expect(tool, scope).toBeDefined();
      expect(tool!.description, scope).toBe(desc);
      expect(Object.keys(tool!.outputSchema?.properties ?? {}).sort(), scope).toEqual(out);
      expect(Object.keys(tool!.inputSchema.properties ?? {}).sort(), scope).toEqual(["folder_id", "group_id", "space"]);
      expect(tool!.inputSchema.additionalProperties, scope).toBe(false);
    }
    const plain = await buildTestApp();
    const v = await seedUser(plain.db);
    const { token } = await seedTokenForUser(plain.db, v.id, RW);
    expect((await toolList(plain.app, { token })).map(t => t.name)).not.toContain(TOOL);
  });
});

describe("#417: instructions mention open_notes_as_files only when it is on the list, one sentence each for read-write and read-only", () => {
  const HINT_RW = "If you have a shell, use open_notes_as_files to change much of a note, or many notes.";
  const HINT_RO = "If you have a shell, use open_notes_as_files to read many or whole notes.";
  async function instructionsOf(app: Parameters<typeof mcpPost>[0], opts: { token?: string; cookie?: string }): Promise<string> {
    const res = await mcpPost(app, INITIALIZE, opts);
    expect(res.statusCode).toBe(200);
    return res.json().result.instructions as string;
  }

  it("collab: read-only token -> the read sentence; read-write / read-write-move-delete token -> the write sentence; session -> neither; no-collab read-write / read-only token -> neither; all four forms at most 1000", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    for (const [scope, hint, other] of [
      [RO, HINT_RO, HINT_RW],
      [RW, HINT_RW, HINT_RO],
      [RWMD, HINT_RW, HINT_RO],
    ] as const) {
      const { token } = await seedTokenForUser(ctx.db, u.id, scope);
      expect((await toolList(ctx.app, { token })).map(t => t.name), scope).toContain(TOOL);
      const text = await instructionsOf(ctx.app, { token });
      expect(text, scope).toContain(hint);
      expect(text, scope).not.toContain(other);
      expect(text.length, scope).toBeLessThanOrEqual(1000);
    }
    const cookie = (await cookieOf(u.id))[SESSION_COOKIE]!;
    expect((await toolList(ctx.app, { cookie })).map(t => t.name)).not.toContain(TOOL);
    expect(await instructionsOf(ctx.app, { cookie })).not.toContain(TOOL);

    const plain = await buildTestApp();
    const v = await seedUser(plain.db);
    for (const scope of [RO, RW] as const) {
      const { token } = await seedTokenForUser(plain.db, v.id, scope);
      expect((await toolList(plain.app, { token })).map(t => t.name), scope).not.toContain(TOOL);
      expect(await instructionsOf(plain.app, { token }), scope).not.toContain(TOOL);
    }
  });
});

describe("parent credential revoked while signing", () => {
  it("beforeLock deletes the parent row -> unauthorized + REVOKED_MESSAGE, zero rows", async () => {
    const seam: IssueBulkTransferTokenSeam = {};
    const ctx = await buildCollabTestApp({ config, mcpTestHooks: { issueBulkTransferToken: seam } });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    seam.beforeLock = async () => {
      await ctx.db.delete(apiTokens).where(eq(apiTokens.id, a.tokenId));
    };
    expect((await callTool(ctx.app, a.token, TOOL, {})).structuredContent).toEqual({ code: "unauthorized", message: REVOKED_MESSAGE });
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(0);
  });
});

describe("concurrent signing on one parent credential: the lock on the parent row serializes the count", () => {
  it("already 2: the first call stops at afterCount, the second blocks on the parent row lock (blocked); after release exactly 3 and the second is too_many_requests", async () => {
    const seam: IssueBulkTransferTokenSeam = {};
    const ctx = await buildCollabTestApp({ config, mcpTestHooks: { issueBulkTransferToken: seam } });
    const pool = ctx.db.$client;
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    // Warm-up: let touchLastUsed (the api_tokens UPDATE) finish first, otherwise its row lock would be mistaken for evidence that the second call is blocked (same as mcp-transfer-flow).
    expect((await mcpPost(ctx.app, rpc("tools/list"), { token: a.token })).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) await issueBulkDirect(ctx.db, a.tokenId);
    let calls = 0;
    let second: ReturnType<typeof callTool> | undefined;
    let state: "blocked" | "settled" | undefined;
    seam.afterCount = async () => {
      if (calls++ !== 0) return;
      second = callTool(ctx.app, a.token, TOOL, {});
      state = await waitForBlockedOrSettled(pool, second);
    };
    const first = await callTool(ctx.app, a.token, TOOL, {});
    const secondResult = await second!;
    expect(state).toBe("blocked");
    expect(first.isError).toBeUndefined();
    expect(secondResult.structuredContent.code).toBe("too_many_requests");
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(3);
  });
});

describe("output shape and curl", () => {
  const checkCurls = (sc: Record<string, unknown>, keys: readonly ("export" | "note" | "write" | "revoke")[]) => {
    const t = sc.token as string;
    expect(t.startsWith("knbt_")).toBe(true);
    const curls = bulkCurls(ORIGIN, t);
    for (const k of keys) {
      expect(sc[k], k).toEqual(curls[k]);
      const c = (sc[k] as { url: string; curl: string }).curl;
      expect(c.split(t).length - 1, k).toBe(1);
      expect(c, k).toContain(`-H "Authorization: Bearer ${t}"`);
      for (const m of c.matchAll(/https?:\/\/[^"/]+/g)) expect(m[0], k).toBe(ORIGIN);
    }
  };
  it("RO: keys exactly {token, expiresAt, access, export, note, revoke, next} (no write); three curl groups; access read; next = RO", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RO);
    const sc = (await callTool(ctx.app, token, TOOL, {})).structuredContent;
    expect(Object.keys(sc).sort()).toEqual(["access", "expiresAt", "export", "next", "note", "revoke", "token"]);
    expect(sc.access).toBe("read");
    checkCurls(sc, ["export", "note", "revoke"]);
    expect(sc.next).toBe(BULK_NEXT_RO);
  });
  it("RW (read-write, read-write-move-delete): one more key `write` (eight keys); four curl groups point only at publicOrigin, the token is only in the Authorization header; access write; next = RW", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    for (const scope of [RW, RWMD]) {
      const { token } = await seedTokenForUser(ctx.db, u.id, scope);
      const sc = (await callTool(ctx.app, token, TOOL, {})).structuredContent;
      expect(Object.keys(sc).sort(), scope).toEqual(["access", "expiresAt", "export", "next", "note", "revoke", "token", "write"]);
      expect(sc.access, scope).toBe("write");
      checkCurls(sc, ["export", "note", "write", "revoke"]);
      expect(sc.next, scope).toBe(BULK_NEXT_RW);
    }
  });
});

describe("RW credential end to end (sign -> export -> edit one note -> write -> 200)", () => {
  it("the export.curl URL yields a tar.gz, edit one note's body, PUT with write.curl's URL/headers -> 200 applied, the note's content is replaced", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: u.id }, { title: "E2E" });
    await seedMd(ctx.db, n.id, "First para\n\nSecond para");
    const { token } = await seedTokenForUser(ctx.db, u.id, RW);
    const sc = (await callTool(ctx.app, token, TOOL, {})).structuredContent as Record<string, { url: string; curl: string }> & { token: string };
    const ex = await exportRaw(ctx.baseUrl, sc.token, new URL(sc.export.url).pathname);
    expect(ex.status).toBe(200);
    const file = readTarGz(ex.body).find(e => e.type === "file" && e.data.toString("utf8").includes(n.id))!;
    expect(file).toBeDefined();
    const text = file.data.toString("utf8").replace("Second para", "Second para changed by agent");
    // Method, headers and URL of write.curl are taken from the curl string itself rather than copied.
    expect(sc.write.curl).toContain("-X PUT");
    expect(sc.write.curl).toContain('-H "Content-Type: text/markdown; charset=utf-8"');
    const r = await ctx.app.inject({
      method: "PUT",
      url: new URL(sc.write.url).pathname,
      headers: { authorization: `Bearer ${sc.token}`, "content-type": "text/markdown; charset=utf-8" },
      payload: text,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: n.id, result: "applied", applied: 1 });
    expect((await liveMarkdown(ctx, n.id)).replace(/\n+$/, "")).toBe("First para\n\nSecond para changed by agent");
  });
});

describe("expired rows are cleaned after signing", () => {
  it("an expired row -> gone after a successful signing; an unexpired one stays", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    const dead = await issueBulkDirect(ctx.db, a.tokenId);
    const live = await issueBulkDirect(ctx.db, a.tokenId);
    await expireToken(ctx.db, dead.id);
    expect((await callTool(ctx.app, a.token, TOOL, {})).isError).toBeUndefined();
    await vi.waitFor(
      async () => {
        const ids = (await ctx.db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
        expect(ids).not.toContain(dead.id);
        expect(ids).toContain(live.id);
      },
      { timeout: 5_000 },
    );
  });
});

describe("strict", () => {
  it("an extra key spaces -> SDK input validation error, zero rows", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    const r = await callTool(ctx.app, a.token, TOOL, { spaces: "personal" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Input validation error");
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(0);
  });
});
