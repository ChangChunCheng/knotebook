import { describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, type AdminKnowledgeFieldsDto, type KnowledgeFieldInput, type KnowledgeFieldsDto, type KnowledgeOptionInput } from "@knotebook/shared";
import { knowledgeFieldDefs, knowledgeFieldOverrides } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";

const UNKNOWN = "00000000-0000-4000-8000-00000000dead";
const errorCode = (res: { json(): unknown }): string => (res.json() as { error: { code: string } }).error.code;

async function ctx() {
  const c = await buildTestApp();
  const admin = await seedUser(c.db, { isAdmin: true });
  return { ...c, admin };
}

async function getFields(app: FastifyInstance, userId: string, qs = "") {
  return app.inject({ method: "GET", url: `/api/knowledge/fields${qs}`, cookies: await cookieOf(userId) });
}
async function putAdmin(app: FastifyInstance, userId: string, body: unknown) {
  return app.inject({ method: "PUT", url: "/api/admin/knowledge-fields", cookies: await cookieOf(userId), payload: body as object });
}

const opt = (key: string, extra: Partial<KnowledgeOptionInput> = {}): KnowledgeOptionInput => ({ key, name: null, enabled: true, ...extra });
const BUILTIN_OPTIONS = (): KnowledgeOptionInput[] => [opt("tested"), opt("docs"), opt("inferred")];
function fieldsBody(over: { enabled?: Record<string, boolean>; options?: KnowledgeOptionInput[] } = {}): { fields: KnowledgeFieldInput[] } {
  return {
    fields: (["when", "conclusion", "evidence", "verified", "superseded_by"] as const).map((key) => ({
      key,
      enabled: over.enabled?.[key] ?? true,
      ...(key === "evidence" ? { options: over.options ?? BUILTIN_OPTIONS() } : {}),
    })),
  };
}

describe("reading the effective settings", () => {
  it("with no rows every reader of a note gets the default view", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const note = await seedNote(db, { ownerId: alice.id });

    const own = await getFields(app, alice.id, `?note=${note.id}`);
    expect(own.statusCode, own.body).toBe(200);
    expect((own.json() as KnowledgeFieldsDto).fields).toEqual(JSON.parse(JSON.stringify(DEFAULT_KNOWLEDGE_FIELD_VIEW.fields)));
    expect((await getFields(app, alice.id)).statusCode).toBe(200);

    expect((await getFields(app, bob.id, `?note=${note.id}`)).statusCode).toBe(404);
    await seedShare(db, note.id, bob.id, "editor");
    expect((await getFields(app, bob.id, `?note=${note.id}`)).statusCode).toBe(200);
  });

  it("group members can read the group's view and others get 404", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "Research", [{ userId: alice.id, role: "member" }]);
    const note = await seedNote(db, { groupId: g.id });
    expect((await getFields(app, alice.id, `?group=${g.id}`)).statusCode).toBe(200);
    expect((await getFields(app, alice.id, `?note=${note.id}`)).statusCode).toBe(200);
    expect((await getFields(app, bob.id, `?group=${g.id}`)).statusCode).toBe(404);
    expect((await getFields(app, bob.id, `?note=${note.id}`)).statusCode).toBe(404);
  });

  it("a malformed, unknown or conflicting reference is 404 and an unauthenticated request is 401", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    for (const qs of ["?note=nope", `?note=${UNKNOWN}`, `?group=${UNKNOWN}`, "?group=1", `?note=${UNKNOWN}&group=${UNKNOWN}`, "?other=1", `?note=${UNKNOWN}&note=${UNKNOWN}`]) {
      const res = await getFields(app, alice.id, qs);
      expect(res.statusCode, qs).toBe(404);
      expect(errorCode(res)).toBe("not_found");
    }
    expect((await app.inject({ method: "GET", url: "/api/knowledge/fields" })).statusCode).toBe(401);
  });
});

describe("the admin endpoints", () => {
  it("an admin can turn off a builtin field, rename and add basis options, and only differences are stored", async () => {
    const { app, db, admin } = await ctx();
    const bob = await seedUser(db);
    const res = await putAdmin(app, admin.id, fieldsBody({
      enabled: { when: false },
      options: [opt("tested"), opt("docs", { name: "Spec" }), opt("inferred"), opt("vendor-doc", { name: "Vendor docs" })],
    }));
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as AdminKnowledgeFieldsDto;
    expect(dto.limits).toEqual({ customEnabledMax: 20, customTotalMax: 100, optionsMax: 30, nameMax: 60 });

    const seen = await getFields(app, bob.id);
    expect(seen.statusCode).toBe(200);
    const fields = (seen.json() as KnowledgeFieldsDto).fields;
    expect(fields.find((f) => f.key === "when")!.enabled).toBe(false);
    expect(fields.find((f) => f.key === "conclusion")!.enabled).toBe(true);
    expect(fields.find((f) => f.key === "evidence")!.options!.map((o) => [o.key, o.name, o.enabled, o.builtin])).toEqual([
      ["tested", null, true, true],
      ["docs", "Spec", true, true],
      ["inferred", null, true, true],
      ["vendor-doc", "Vendor docs", true, false],
    ]);
    expect(dto.fields).toEqual(fields);

    const rows = await db.select().from(knowledgeFieldOverrides).orderBy(asc(knowledgeFieldOverrides.fieldRef), asc(knowledgeFieldOverrides.optionKey));
    expect(rows.map((r) => [r.groupId, r.fieldRef, r.optionKey, r.enabled, r.name, r.position])).toEqual([
      [null, "evidence", "docs", null, "Spec", null],
      [null, "evidence", "vendor-doc", null, "Vendor docs", 3],
      [null, "when", "", false, null, null],
    ]);
    const defs = await db.select().from(knowledgeFieldDefs);
    expect(defs.map((d) => [d.kind, d.fieldRef, d.key, d.type, d.originKind, d.originGroupId])).toEqual([["option", "evidence", "vendor-doc", null, "site", null]]);

    expect(((await app.inject({ method: "GET", url: "/api/admin/knowledge-fields", cookies: await cookieOf(admin.id) })).json() as AdminKnowledgeFieldsDto).fields).toEqual(fields);
  });

  it("a reordered or closed option is stored with its new position and a closed flag", async () => {
    const { app, db, admin } = await ctx();
    const res = await putAdmin(app, admin.id, fieldsBody({ options: [opt("docs"), opt("tested", { enabled: false }), opt("inferred")] }));
    expect(res.statusCode, res.body).toBe(200);
    const options = (res.json() as AdminKnowledgeFieldsDto).fields.find((f) => f.key === "evidence")!.options!;
    expect(options.map((o) => [o.key, o.enabled])).toEqual([["docs", true], ["tested", false], ["inferred", true]]);
    const rows = await db.select().from(knowledgeFieldOverrides).orderBy(asc(knowledgeFieldOverrides.optionKey));
    expect(rows.map((r) => [r.optionKey, r.enabled, r.position])).toEqual([["docs", null, 0], ["tested", false, 1]]);
  });

  it("leaving out an existing option is refused and nothing is written", async () => {
    const { app, db, admin } = await ctx();
    expect((await putAdmin(app, admin.id, fieldsBody({ options: [...BUILTIN_OPTIONS(), opt("vendor-doc", { name: "Vendor docs" })] }))).statusCode).toBe(200);
    const before = await db.select().from(knowledgeFieldOverrides);
    for (const options of [[opt("tested"), opt("docs"), opt("inferred")], [opt("tested"), opt("inferred"), opt("vendor-doc", { name: "Vendor docs" })]]) {
      const res = await putAdmin(app, admin.id, fieldsBody({ enabled: { when: false }, options }));
      expect(res.statusCode, res.body).toBe(400);
      expect(errorCode(res)).toBe("knowledge_fields_incomplete");
    }
    expect(await db.select().from(knowledgeFieldOverrides)).toEqual(before);
    expect(await db.select().from(knowledgeFieldDefs)).toHaveLength(1);
  });

  it("leaving out a builtin field or the basis options is refused as incomplete", async () => {
    const { app, admin } = await ctx();
    const body = fieldsBody();
    const withoutVerified = { fields: body.fields.filter((f) => f.key !== "verified") };
    const noOptions = { fields: body.fields.map(({ options: _o, ...f }) => f) };
    for (const b of [withoutVerified, noOptions]) {
      const res = await putAdmin(app, admin.id, b);
      expect(res.statusCode, res.body).toBe(400);
      expect(errorCode(res)).toBe("knowledge_fields_incomplete");
    }
  });

  it("a reserved or malformed option key is refused", async () => {
    const { app, db, admin } = await ctx();
    for (const key of ["unconfirmed", "Bad", "", "a_b", "x".repeat(65)]) {
      const res = await putAdmin(app, admin.id, fieldsBody({ options: [...BUILTIN_OPTIONS(), opt(key, { name: "Name" })] }));
      expect(res.statusCode, key).toBe(400);
      expect(errorCode(res), key).toBe("knowledge_key_invalid");
    }
    expect(await db.select().from(knowledgeFieldDefs)).toEqual([]);
  });

  it("a repeated option key, too many options, bad names and a missing name are refused with their own codes", async () => {
    const { app, admin } = await ctx();
    const code = async (options: KnowledgeOptionInput[], status = 400) => {
      const res = await putAdmin(app, admin.id, fieldsBody({ options }));
      expect(res.statusCode, res.body).toBe(status);
      return errorCode(res);
    };
    expect(await code([...BUILTIN_OPTIONS(), opt("a", { name: "A" }), opt("a", { name: "B" })])).toBe("knowledge_key_taken");
    expect(await code([...BUILTIN_OPTIONS(), opt("docs")])).toBe("knowledge_key_taken");
    const many = Array.from({ length: 28 }, (_, i) => opt(`o${i}`, { name: `Option ${i}` }));
    expect(await code([...BUILTIN_OPTIONS(), ...many])).toBe("knowledge_fields_limit");
    expect(await code([...BUILTIN_OPTIONS(), opt("fresh")])).toBe("invalid_body");
    expect(await code([...BUILTIN_OPTIONS(), opt("fresh", { name: "   " })])).toBe("invalid_body");
    expect(await code([...BUILTIN_OPTIONS(), opt("fresh", { name: "a\nb" })])).toBe("invalid_body");
    expect(await code([...BUILTIN_OPTIONS(), opt("fresh", { name: "x".repeat(61) })])).toBe("invalid_body");
    expect(await code([opt("tested", { name: "ok\u0000" }), opt("docs"), opt("inferred")])).toBe("invalid_body");
  });

  it("exactly 30 options and a 60 character name are accepted, and a name is trimmed", async () => {
    const { app, admin } = await ctx();
    const extra = Array.from({ length: 27 }, (_, i) => opt(`o${i}`, { name: `Option ${i}` }));
    extra[0] = opt("o0", { name: `  ${"é".repeat(60)}  ` });
    const res = await putAdmin(app, admin.id, fieldsBody({ options: [...BUILTIN_OPTIONS(), ...extra] }));
    expect(res.statusCode, res.body).toBe(200);
    const options = (res.json() as AdminKnowledgeFieldsDto).fields.find((f) => f.key === "evidence")!.options!;
    expect(options).toHaveLength(30);
    expect(options[3]!.name).toBe("é".repeat(60));
  });

  it("saving the defaults back leaves only the new option's position and name and keeps the definition", async () => {
    const { app, db, admin } = await ctx();
    expect((await putAdmin(app, admin.id, fieldsBody({
      enabled: { verified: false },
      options: [opt("docs", { name: "Spec" }), opt("tested", { enabled: false }), opt("inferred"), opt("vendor-doc", { name: "Vendor docs" })],
    }))).statusCode).toBe(200);
    const res = await putAdmin(app, admin.id, fieldsBody({ options: [...BUILTIN_OPTIONS(), opt("vendor-doc", { name: "Vendor docs" })] }));
    expect(res.statusCode, res.body).toBe(200);
    const rows = await db.select().from(knowledgeFieldOverrides);
    expect(rows.map((r) => [r.fieldRef, r.optionKey, r.enabled, r.name, r.position])).toEqual([["evidence", "vendor-doc", null, "Vendor docs", 3]]);
    expect(await db.select().from(knowledgeFieldDefs)).toHaveLength(1);

    const plain = await putAdmin(app, admin.id, fieldsBody({ options: [...BUILTIN_OPTIONS(), opt("vendor-doc", { name: "Vendor docs", enabled: false })] }));
    expect(plain.statusCode, plain.body).toBe(200);
    expect((await db.select().from(knowledgeFieldOverrides)).map((r) => [r.optionKey, r.enabled])).toEqual([["vendor-doc", false]]);
  });

  it("a custom field is refused in this release of the endpoint", async () => {
    const { app, db, admin } = await ctx();
    const body = fieldsBody();
    const res = await putAdmin(app, admin.id, { fields: [...body.fields, { key: "x-owner", enabled: true, name: "Owner", type: "member" }] });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorCode(res)).toBe("invalid_body");
    expect(await db.select().from(knowledgeFieldDefs)).toEqual([]);
  });

  it("other malformed bodies are 400 invalid_body", async () => {
    const { app, admin } = await ctx();
    const body = fieldsBody();
    const bad: unknown[] = [
      null,
      {},
      { fields: "x" },
      { fields: body.fields, extra: 1 },
      { fields: [...body.fields, { key: "when", enabled: true }] },
      { fields: [...body.fields, { key: "other", enabled: true }] },
      { fields: body.fields.map((f) => (f.key === "when" ? { ...f, name: "Renamed" } : f)) },
      { fields: body.fields.map((f) => (f.key === "when" ? { ...f, type: "text" } : f)) },
      { fields: body.fields.map((f) => (f.key === "when" ? { ...f, options: [] } : f)) },
      { fields: body.fields.map((f) => (f.key === "when" ? { ...f, enabled: "yes" } : f)) },
    ];
    for (const b of bad) {
      const res = await putAdmin(app, admin.id, b);
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
      expect(errorCode(res), JSON.stringify(b)).toBe("invalid_body");
    }
  });

  it("a non-admin cannot read or write the admin endpoints", async () => {
    const { app, db } = await ctx();
    const bob = await seedUser(db);
    const get = await app.inject({ method: "GET", url: "/api/admin/knowledge-fields", cookies: await cookieOf(bob.id) });
    const put = await putAdmin(app, bob.id, fieldsBody());
    const limits = await app.inject({ method: "GET", url: "/api/admin/limits", cookies: await cookieOf(bob.id) });
    expect(limits.statusCode).toBe(403);
    expect(get.statusCode).toBe(limits.statusCode);
    expect(put.statusCode).toBe(limits.statusCode);
    expect((await app.inject({ method: "GET", url: "/api/admin/knowledge-fields" })).statusCode).toBe(401);
  });
});
