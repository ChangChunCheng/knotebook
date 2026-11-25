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

  it("an admin can add each custom field type and readers see them in order", async () => {
    const { app, db, admin } = await ctx();
    const bob = await seedUser(db);
    const body = fieldsBody();
    const res = await putAdmin(app, admin.id, {
      fields: [
        ...body.fields,
        { key: "x-team", enabled: true, name: "Team", type: "text" },
        { key: "x-area", enabled: true, name: "Area", type: "select", options: [opt("a", { name: "Area A" }), opt("b", { name: "Area B" })] },
        { key: "x-due", enabled: false, name: "Due", type: "date" },
        { key: "x-doc", enabled: true, name: "Doc", type: "link" },
        { key: "x-owner", enabled: true, name: "Owner", type: "member" },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const seen = (await getFields(app, bob.id)).json() as KnowledgeFieldsDto;
    const custom = seen.fields.filter((f) => !f.builtin);
    expect(custom.map((f) => [f.key, f.type, f.name, f.enabled])).toEqual([
      ["x-team", "text", "Team", true],
      ["x-area", "select", "Area", true],
      ["x-due", "date", "Due", false],
      ["x-doc", "link", "Doc", true],
      ["x-owner", "member", "Owner", true],
    ]);
    expect(custom[1]!.options!.map((o) => [o.key, o.name, o.builtin])).toEqual([["a", "Area A", false], ["b", "Area B", false]]);
    expect((res.json() as AdminKnowledgeFieldsDto).fields).toEqual(seen.fields);

    const defs = await db.select().from(knowledgeFieldDefs);
    expect(defs.map((d) => [d.kind, d.fieldRef, d.key, d.type]).sort()).toEqual([
      ["field", "x-area", "area", "select"],
      ["field", "x-doc", "doc", "link"],
      ["field", "x-due", "due", "date"],
      ["field", "x-owner", "owner", "member"],
      ["field", "x-team", "team", "text"],
      ["option", "x-area", "a", null],
      ["option", "x-area", "b", null],
    ]);

    const reordered = await putAdmin(app, admin.id, {
      fields: [...body.fields, ...[...custom].reverse().map((f) => ({
        key: f.key,
        enabled: f.enabled,
        name: f.name,
        ...(f.options ? { options: f.options.map((o) => opt(o.key, { name: o.name })) } : {}),
      }))],
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(((await getFields(app, bob.id)).json() as KnowledgeFieldsDto).fields.filter((f) => !f.builtin).map((f) => f.key)).toEqual(["x-owner", "x-doc", "x-due", "x-area", "x-team"]);
  });

  it("the twenty-first enabled custom field and the hundred-and-first in total are refused", async () => {
    const { app, db, admin } = await ctx();
    const body = fieldsBody();
    const make = (n: number, enabled: boolean) => ({ key: `x-f${n}`, enabled, name: `Field ${n}`, type: "text" as const });
    const twentyOne = Array.from({ length: 21 }, (_, i) => make(i, true));
    const tooMany = await putAdmin(app, admin.id, { fields: [...body.fields, ...twentyOne] });
    expect(tooMany.statusCode, tooMany.body).toBe(400);
    expect(errorCode(tooMany)).toBe("knowledge_fields_limit");
    expect(await db.select().from(knowledgeFieldDefs)).toEqual([]);

    const hundred = Array.from({ length: 100 }, (_, i) => make(i, i < 20));
    const ok = await putAdmin(app, admin.id, { fields: [...body.fields, ...hundred] });
    expect(ok.statusCode, ok.body).toBe(200);
    const over = await putAdmin(app, admin.id, { fields: [...body.fields, ...hundred, make(100, false)] });
    expect(over.statusCode, over.body).toBe(400);
    expect(errorCode(over)).toBe("knowledge_fields_limit");
    expect(await db.select().from(knowledgeFieldDefs)).toHaveLength(100);
  });

  it("a custom field's type cannot change and it cannot be left out", async () => {
    const { app, db, admin } = await ctx();
    const body = fieldsBody();
    const team = { key: "x-team", enabled: true, name: "Team", type: "text" };
    expect((await putAdmin(app, admin.id, { fields: [...body.fields, team] })).statusCode).toBe(200);

    const retype = await putAdmin(app, admin.id, { fields: [...body.fields, { ...team, type: "link" }] });
    expect(retype.statusCode, retype.body).toBe(400);
    expect(errorCode(retype)).toBe("invalid_body");

    const left = await putAdmin(app, admin.id, body);
    expect(left.statusCode, left.body).toBe(400);
    expect(errorCode(left)).toBe("knowledge_fields_incomplete");

    const same = await putAdmin(app, admin.id, { fields: [...body.fields, { key: "x-team", enabled: false, name: "Squad" }] });
    expect(same.statusCode, same.body).toBe(200);
    expect(await db.select().from(knowledgeFieldDefs)).toHaveLength(1);
  });

  it("a turned-off custom field keeps its key, and a new field cannot take it", async () => {
    const { app, db, admin } = await ctx();
    const body = fieldsBody();
    expect((await putAdmin(app, admin.id, { fields: [...body.fields, { key: "x-team", enabled: false, name: "Team", type: "text" }] })).statusCode).toBe(200);
    const taken = await putAdmin(app, admin.id, { fields: [...body.fields, { key: "x-team", enabled: true, name: "Team", type: "select", options: [] }] });
    expect(taken.statusCode, taken.body).toBe(400);
    expect(errorCode(taken)).toBe("invalid_body");
    const stored = await db.select().from(knowledgeFieldDefs);
    expect(stored.map((d) => [d.fieldRef, d.type])).toEqual([["x-team", "text"]]);
    const fields = ((await getFields(app, admin.id)).json() as KnowledgeFieldsDto).fields;
    expect(fields.find((f) => f.key === "x-team")).toMatchObject({ enabled: false, name: "Team" });
  });

  it("custom field input is checked: key, type, name, options and their keys", async () => {
    const { app, db, admin } = await ctx();
    const body = fieldsBody();
    const code = async (field: unknown, status = 400) => {
      const res = await putAdmin(app, admin.id, { fields: [...body.fields, field] });
      expect(res.statusCode, `${JSON.stringify(field)} ${res.body}`).toBe(status);
      return errorCode(res);
    };
    const text = { key: "x-ok", enabled: true, name: "Ok", type: "text" };
    expect(await code({ ...text, key: "x-Bad" })).toBe("knowledge_key_invalid");
    expect(await code({ ...text, key: "x-" })).toBe("knowledge_key_invalid");
    expect(await code({ ...text, key: `x-${"a".repeat(65)}` })).toBe("knowledge_key_invalid");
    expect(await code({ ...text, type: undefined })).toBe("invalid_body");
    expect(await code({ ...text, name: undefined })).toBe("invalid_body");
    expect(await code({ ...text, name: null })).toBe("invalid_body");
    expect(await code({ ...text, name: " " })).toBe("invalid_body");
    expect(await code({ ...text, name: "x".repeat(61) })).toBe("invalid_body");
    expect(await code({ ...text, type: "number" })).toBe("invalid_body");
    expect(await code({ ...text, options: [] })).toBe("invalid_body");
    const select = { key: "x-sel", enabled: true, name: "Sel", type: "select" };
    expect(await code(select)).toBe("knowledge_fields_incomplete");
    expect(await code({ ...select, options: [opt("a", { name: "A" }), opt("a", { name: "B" })] })).toBe("knowledge_key_taken");
    expect(await code({ ...select, options: [opt("Bad", { name: "A" })] })).toBe("knowledge_key_invalid");
    expect(await code({ ...select, options: [opt("a")] })).toBe("invalid_body");
    expect(await code({ ...select, options: Array.from({ length: 31 }, (_, i) => opt(`o${i}`, { name: "N" })) })).toBe("knowledge_fields_limit");
    expect(await db.select().from(knowledgeFieldDefs)).toEqual([]);
    const dup = await putAdmin(app, admin.id, { fields: [...body.fields, text, text] });
    expect(dup.statusCode).toBe(400);
  });

  it("a custom select has no reserved option words and cannot drop an existing option", async () => {
    const { app, db, admin } = await ctx();
    const body = fieldsBody();
    const sel = (options: KnowledgeOptionInput[]) => ({ key: "x-sel", enabled: true, name: "Sel", type: "select", options });
    expect((await putAdmin(app, admin.id, { fields: [...body.fields, sel([opt("tested", { name: "Tested" }), opt("unconfirmed", { name: "U" }), opt("b", { name: "B" })])] })).statusCode).toBe(200);
    const dropped = await putAdmin(app, admin.id, { fields: [...body.fields, sel([opt("tested", { name: "Tested" }), opt("unconfirmed", { name: "U" })])] });
    expect(dropped.statusCode, dropped.body).toBe(400);
    expect(errorCode(dropped)).toBe("knowledge_fields_incomplete");
    expect((await db.select().from(knowledgeFieldDefs)).filter((d) => d.kind === "option")).toHaveLength(3);
    const evidenceOptions = ((await getFields(app, admin.id)).json() as KnowledgeFieldsDto).fields.find((f) => f.key === "evidence")!.options!;
    expect(evidenceOptions.map((o) => o.key)).toEqual(["tested", "docs", "inferred"]);
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
