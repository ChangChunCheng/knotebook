import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { SESSION_COOKIE, validateSlug } from "@knotebook/shared";
import { buildTestApp, freshDb, signTestSession } from "./helpers.js";
import { noteShares, notes, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { NO_PERMISSIONS, OWNER_PERMISSIONS, resolveNoteAccess, sharePermissions } from "../src/notes/service.js";
import { UserGate } from "../src/auth/session.js";

async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
    })
    .returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signTestSession({ userId, tv: 0 });
}

describe("PATCH /api/notes/:id - slug", () => {
  it("owner sets slug -> 200, slug returned", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "my-note" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ slug: "my-note" });
  });

  it("owner clears slug (slug:null) -> 200, back to auto (computed from the DB's current title; pre-read, no title in the request)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug2@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Stay Title" } })
    ).json();

    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "clear-me" },
    });
    expect(setRes.statusCode).toBe(200);

    const clearRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: null },
    });
    expect(clearRes.statusCode).toBe(200);
    // slug is NOT NULL (#122): clearing returns to the auto form (no title in the request: computed from the DB's current title)
    expect(clearRes.json()).toMatchObject({ slug: "stay-title" });
  });

  it("an NFD variant also resolves a slug stored as NFC (by-path since #122: normalizeSlug composes both sides to NFC before comparing)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug3@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const nfc = "café"; // é = U+00E9 (single precomposed character)
    const nfd = "café"; // e + U+0301 (combining acute); equals nfc after normalize("NFC")
    expect(nfd.normalize("NFC")).toBe(nfc);

    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: nfc },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().slug).toBe(nfc);

    const res = await app.inject({
      method: "GET",
      url: `/api/notes/by-path/${owner.handle}/${encodeURIComponent(nfd)}`,
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id, slug: nfc });
  });

  it("non-owner matrix: none -> 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug4@example.com" });
    const stranger = await insertUser(db, { email: "stranger-slug4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
      payload: { slug: "nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-owner matrix: editor with slug -> 403 (whole request rejected, not let through because of a valid title)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug5@example.com" });
    const editor = await insertUser(db, { email: "editor-slug5@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "editor-slug5@example.com", role: "editor" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "should not apply", slug: "editor-slug" },
    });
    expect(res.statusCode).toBe(403);

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie } });
    // slug untouched: still the DB default from POST (`untitled-<uuid8>`)
    expect(getRes.json()).toMatchObject({ title: "Untitled", slug: note.slug });
  });

  it("non-owner matrix: editor sends only title (no slug) -> 200, and **recomputes the owner's auto slug** (intentional)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug6@example.com" });
    const editor = await insertUser(db, { email: "editor-slug6@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "editor-slug6@example.com", role: "editor" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "editor can rename" },
    });
    expect(res.statusCode).toBe(200);
    // An editor is a trusted collaborator who may already change the title; the auto slug following the title is an extension of the
    // same thing (no throttle, no prev kept; the abuse surface is the same social-layer one as an editor scribbling the title, accepted deliberately).
    expect(res.json()).toMatchObject({ title: "editor can rename", slug: "editor-can-rename" });
  });

  it("mixed {title, slug} hitting 409: title is not applied either (single-UPDATE atomicity)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug7@example.com" });
    const cookie = await cookieFor(owner.id);
    const noteA = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "A" } })
    ).json();
    const noteB = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "B" } })
    ).json();

    const takeRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${noteA.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "taken-slug" },
    });
    expect(takeRes.statusCode).toBe(200);

    const conflictRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${noteB.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "B changed", slug: "taken-slug" },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json()).toMatchObject({ error: { code: "slug_taken" } });

    const getRes = await app.inject({ method: "GET", url: `/api/notes/${noteB.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    // Single UPDATE is atomic: on 409 neither title nor slug changed (slug is still the value derived at POST: both notes carry a title,
    // so since #145 the slug follows the title at creation instead of being the DB default)
    expect(getRes.json()).toMatchObject({ title: "B", slug: noteB.slug });
  });

  it("concurrent requests for the same slug: exactly one 409 (decided by the DB unique index; \"no pre-check SELECT\" is guarded by the statement-shape case)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug8@example.com" });
    const cookie = await cookieFor(owner.id);
    const noteA = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const noteB = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const [res1, res2] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/notes/${noteA.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: "race-slug" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/notes/${noteB.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: "race-slug" },
      }),
    ]);

    const codes = [res1.statusCode, res2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const conflict = res1.statusCode === 409 ? res1 : res2;
    expect(conflict.json()).toMatchObject({ error: { code: "slug_taken" } });
  });

  it("invalid slug format (uuid-like) -> 400", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug9@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("11th PATCH with a non-null slug -> 429 too_many_requests, body without retryAfterMs (per-user throttle of 10 per 10 minutes)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug10@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: `slug-attempt-${i}` },
      });
    }
    expect(last!.statusCode).toBe(429);
    const body = last!.json();
    expect(body).toEqual({ error: { code: "too_many_requests", message: expect.any(String) } });
    expect(body.retryAfterMs).toBeUndefined();
  });

  it("slug:null **counts** against the slugPatch throttle (counted on entering the slug branch): the 11th clear gets 429", async () => {
    // {slug:null} is a real write (back to auto), so it shares the bucket with a slug-only PATCH: counted before validation (null has no format check).
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-slug11@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: null },
      });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toMatchObject({ error: { code: "too_many_requests" } });
  });
});

describe("GET /api/notes/:ref", () => {
  it("uuid ref behaviour unchanged", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id });
  });

  it("#122: legacy refs **only look up legacy_slug**: the current slug is no longer resolved by /notes/:ref; the hijack counter-example resolves to the frozen note", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref2@example.com" });
    const cookie = await cookieFor(owner.id);

    // A existed before 0007 (legacy snapshot non-NULL), inserted directly (INSERT isn't blocked by the trigger, which only locks UPDATE;
    // in production legacy is written only by 0007).
    const [noteA] = await db
      .insert(notes)
      .values({ ownerId: owner.id, title: "Frozen", slug: "frozen-current", legacySlug: "frozen-name" })
      .returning();
    // B is a later note with the same name set as its **current** custom slug
    const noteB = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/notes/${noteB.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "frozen-name" },
    });
    expect(setRes.statusCode).toBe(200);

    // Legacy `/notes/frozen-name` resolves to A (legacy frozen), not B (current custom): legacy links stay frozen in the world of 0007,
    // B's new name goes through by-path.
    const res = await app.inject({ method: "GET", url: "/api/notes/frozen-name", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: noteA.id });

    // frozen-current is **A's** current slug and no note's legacy: a legacy lookup must 404, which guards "doesn't query notes.slug"
    // (an `or(legacy, slug)` implementation would give 200 here).
    const missRes = await app.inject({ method: "GET", url: "/api/notes/frozen-current", cookies: { [SESSION_COOKIE]: cookie } });
    expect(missRes.statusCode).toBe(404);
  });

  it("legacy lookup also goes through normalizeSlug: uppercase and NFD variants resolve (snapshot stored NFC lowercase)", async () => {
    // The NFD case that guarded this moved to by-path in #122, so the legacy branch must cover it itself (removing normalizeSlug(ref)
    // would leave the whole old suite green). The non-normalized sources of legacy links are real: users type uppercase, macOS/IME paste NFD.
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref-nfd@example.com" });
    const cookie = await cookieFor(owner.id);
    const nfcLegacy = "caf\u00e9-legacy"; // U+00E9 precomposed (NFC, snapshot storage form)
    const nfdVariant = "cafe\u0301-legacy"; // e + U+0301 combining acute (NFD decomposed form)
    // All written as code-point escapes (like the normalizeSlug cases in this file): the NFD/NFC difference must not be silently
    // composed away when an editor or tool re-encodes the file.
    expect(nfdVariant.normalize("NFC")).toBe(nfcLegacy); // fixture self-check
    expect(nfdVariant).not.toBe(nfcLegacy);
    const [note] = await db
      .insert(notes)
      .values({ ownerId: owner.id, title: "Cafe", slug: "cafe-current", legacySlug: nfcLegacy })
      .returning();

    for (const variant of ["CAF\u00c9-LEGACY", nfdVariant]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/notes/${encodeURIComponent(variant)}`,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode, JSON.stringify(variant)).toBe(200);
      expect(res.json()).toMatchObject({ id: note.id });
    }
  });

  it("unknown slug that is not a valid uuid format -> 404", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref3@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "GET", url: "/api/notes/no-such-slug", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("old-form long ref with decoded UTF-16 length > 100 still resolves (maxParamLength guard)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-ref-astral@example.com" });
    const cookie = await cookieFor(owner.id);

    // Since #122 slug is NOT NULL and canonicalNotePath no longer builds `<vanity>-<uuid>` long refs, but long links produced by older
    // versions **live forever** (uuid-suffix resolution unchanged), so the `maxParamLength: 512` guard must stay. A hand-built old ref:
    // U+20BB7 (astral, 2 UTF-16 code units) x40 = 80 units, plus `-<uuid>` (37 units) = 117 > find-my-way's default 100 (measured on
    // the decoded UTF-16 length). Without `maxParamLength: 512` in app.ts it is rejected at the routing layer (414; the handler is never called).
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const ref = `${"𠮷".repeat(40)}-${note.id}`;
    expect(ref.length).toBeGreaterThan(100); // decoded UTF-16 length (what find-my-way measures)

    const res = await app.inject({ method: "GET", url: `/api/notes/${encodeURIComponent(ref)}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id });
  });
});

describe("GET /api/notes - list includes slug", () => {
  it("every list entry carries a slug (always a string since #122: new rows take the DB default `untitled-<uuid8>`)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-list-slug@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "listed-slug" },
    });

    const plain = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; slug: string }>;
    expect(body.find(n => n.id === note.id)).toMatchObject({ slug: "listed-slug" });
    expect(body.find(n => n.id === plain.id)?.slug).toMatch(/^untitled-[0-9a-f]{8}$/);
  });
});

describe("PATCH /api/notes/:id - routing matrix (#122)", () => {
  async function dbRow(db: Db, id: string) {
    const [row] = await db
      .select({ slug: notes.slug, slugIsCustom: notes.slugIsCustom, prevSlug: notes.prevSlug, legacySlug: notes.legacySlug })
      .from(notes)
      .where(eq(notes.id, id))
      .limit(1);
    return row;
  }

  it("prev_slug records only custom changes: auto->custom not recorded, custom->custom recorded, custom->auto recorded; legacy never touched", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Prev Rules" } })
    ).json();

    // auto->custom: no prev (it would record leftovers like untitled-<uuid8> as history)
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "first-custom" } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "first-custom", slugIsCustom: true, prevSlug: null, legacySlug: null });

    // custom->custom: records the previous custom name
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "second-custom" } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "second-custom", slugIsCustom: true, prevSlug: "first-custom", legacySlug: null });

    // custom->auto ({slug:null}): records the abandoned custom name, custom flips to false, slug returns to auto
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: null } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "prev-rules", slugIsCustom: false, prevSlug: "second-custom", legacySlug: null });

    // auto recompute (title-only): prev untouched (typing leftovers must not overwrite the real custom history)
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Prev Rules Renamed" } });
    expect(await dbRow(db, note.id)).toMatchObject({ slug: "prev-rules-renamed", slugIsCustom: false, prevSlug: "second-custom", legacySlug: null });
  });

  it("{slug, title} in one request does not trigger recompute; later title-only PATCH leaves the slug alone because custom=true", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx2@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "Changed Title", slug: "pinned" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "Changed Title", slug: "pinned" });

    const res2 = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "Changed Again" },
    });
    expect(res2.json()).toMatchObject({ title: "Changed Again", slug: "pinned" });
  });

  it("{title, slug:null}: auto is computed from the **request's new title** (not the DB's current title)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx3@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Old Name" } })
    ).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "was-custom" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "New Name", slug: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "New Name", slug: "new-name" });
  });

  it("probe excludes the row itself: re-saving with the same title keeps the slug (no oscillating to -2); a uuid-like title falls back to untitled", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx4@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Meeting Notes" } })
    ).json();

    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Meeting Notes" } });
    expect((await dbRow(db, note.id)).slug).toBe("meeting-notes");
    // The title changes slightly but the auto slug is the same: if the predicate didn't exclude this row it would become meeting-notes-2 (oscillation)
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Meeting Notes!" } });
    expect((await dbRow(db, note.id)).slug).toBe("meeting-notes");

    await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { title: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
    });
    expect((await dbRow(db, note.id)).slug).toBe("untitled");
  });

  it("auto collision: a second note of the same owner with the same title gets suffix -2 (never 409); the same name coexists across owners", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx5@example.com" });
    const other = await insertUser(db, { email: "other-mx5@example.com" });
    const cookie = await cookieFor(owner.id);
    const otherCookie = await cookieFor(other.id);

    const a = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shared Title" } })).json();
    const b = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${a.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shared Title" } });
    const resB = await app.inject({ method: "PATCH", url: `/api/notes/${b.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shared Title" } });
    expect(resB.statusCode).toBe(200);
    expect((await dbRow(db, b.id)).slug).toBe("shared-title-2");

    // Across owners: unique per user, another owner's auto slug can't collide with mine
    const c = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: otherCookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${c.id}`, cookies: { [SESSION_COOKIE]: otherCookie }, payload: { title: "Shared Title" } });
    expect((await dbRow(db, c.id)).slug).toBe("shared-title");

    // Custom slugs across owners also coexist (slug_taken only within one owner)
    const resCustom = await app.inject({
      method: "PATCH",
      url: `/api/notes/${c.id}`,
      cookies: { [SESSION_COOKIE]: otherCookie },
      payload: { slug: "shared-title-2" },
    });
    expect(resCustom.statusCode).toBe(200);
  });

  it("probe limit 20: base and -2..-20 all taken -> falls back straight to untitled-<uuid8>", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx6@example.com" });
    const cookie = await cookieFor(owner.id);
    // Occupy directly via db.insert (going through the API would spend the slugPatch bucket of 10 per 10 minutes)
    const taken = ["blocked", ...Array.from({ length: 19 }, (_, i) => `blocked-${i + 2}`)];
    for (const slug of taken) {
      await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug });
    }
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Blocked" } });
    expect(res.statusCode).toBe(200);
    expect((await dbRow(db, note.id)).slug).toMatch(/^untitled-[0-9a-f]{8}$/);
  });

  it("real UPDATE race retry (hook): 5 collisions in a row, the 6th falls back to untitled-<uuid8>, never 409", async () => {
    // slugUpdateTestHook is called each round after the probe and before the UPDATE: race-insert a placeholder with the same owner and
    // slug so the UPDATE really hits the (owner_id, slug) unique index (the probe alone can't catch it).
    const hookCtx: { db?: Db; ownerId?: string } = {};
    const candidates: string[] = [];
    const hook = async (candidate: string) => {
      candidates.push(candidate);
      if (candidates.length <= 5 && hookCtx.db && hookCtx.ownerId) {
        await hookCtx.db.insert(notes).values({ ownerId: hookCtx.ownerId, title: "sniper", slug: candidate });
      }
    };
    const { app, db } = await buildTestApp({ slugUpdateTestHook: hook });
    const owner = await insertUser(db, { email: "owner-mx7@example.com" });
    const cookie = await cookieFor(owner.id);
    hookCtx.db = db;
    hookCtx.ownerId = owner.id;

    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Race Me" } });
    expect(res.statusCode).toBe(200);
    // Rounds 1..5: the candidates the probe gives are all taken by the hook -> index collision, retry; round 6 falls back to the uuid8 form
    expect(candidates).toHaveLength(6);
    expect(candidates[0]).toBe("race-me");
    expect(candidates[5]).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect((await dbRow(db, note.id)).slug).toBe(candidates[5]);
  });

  it("title-only PATCH does **not** count against the slugPatch throttle (deliberate trade-off): 11 in a row all 200", async () => {
    // TitleInput's autosave uses this path; if wrongly counted, the 11th save within 10 minutes would 429 and the core edit path
    // would break (a product-level behaviour with no other guard).
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx8@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { title: `Rename ${i}` },
      });
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(200);
    }
  });

  it("#180: PATCH with a title containing NUL -> 400 invalid_body, DB unchanged (the NUL guard on `TITLE`; without it this falls to pg 22021 -> 500)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-x3@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Keep" } })).json();
    const cols = async () =>
      (await db.select({ title: notes.title, slug: notes.slug, updatedAt: notes.updatedAt }).from(notes).where(eq(notes.id, note.id)))[0];
    const before = await cols();
    expect(before?.title).toBe("Keep");
    const res = await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: `a${String.fromCharCode(0)}b` } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    expect(await cols()).toEqual(before);
  });

  it("slugPatch counts success and failure alike: after 10 invalid-format (400) requests exhaust the quota, the 11th valid slug also gets 429", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx9@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/notes/${note.id}`,
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { slug: "-invalid-" },
      });
      expect(res.statusCode, `第 ${i + 1} 次`).toBe(400);
    }
    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { slug: "perfectly-fine" },
    });
    expect(res.statusCode).toBe(429);
  });

  it("probe lower bound: base and -2..-19 taken -> gets -20 (not uuid8), clamping the limit of exactly 20 from both sides", async () => {
    // Testing "probe limit 20" only from above (all taken -> uuid8) would stay green if the limit were quietly lowered.
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx10@example.com" });
    const cookie = await cookieFor(owner.id);
    const taken = ["bound", ...Array.from({ length: 18 }, (_, i) => `bound-${i + 2}`)];
    for (const slug of taken) {
      await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug });
    }
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Bound" } });
    expect((await dbRow(db, note.id)).slug).toBe("bound-20");
  });

  it("two notes falling back at once -> two distinct fallback slugs (uuid8 is not a fixed string)", async () => {
    // If fallbackAutoSlug returned a fixed value, the second note's 6th UPDATE would hit the index and fail with 500 (the shape
    // assertion /^untitled-[0-9a-f]{8}$/ can't catch a fixed string).
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx11@example.com" });
    const cookie = await cookieFor(owner.id);
    const taken = ["dead", ...Array.from({ length: 19 }, (_, i) => `dead-${i + 2}`)];
    for (const slug of taken) {
      await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug });
    }
    const a = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const b = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${a.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Dead" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${b.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Dead" } })).statusCode).toBe(200);
    const slugA = (await dbRow(db, a.id)).slug;
    const slugB = (await dbRow(db, b.id)).slug;
    expect(slugA).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(slugB).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(slugA).not.toBe(slugB);
  });

  it("dedupe suffix re-truncation: a long base (59 chars) colliding -> total length <= 60, no trailing dash, passes validateSlug (same boundary as the 0007 SQL version)", async () => {
    // Re-truncating the base so the total stays <= 60 is the only arithmetic the TS and SQL implementations must agree on; dedupe
    // cases with short bases can't exercise it (changing 60-suffix.length back to 60 would stay green).
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx12@example.com" });
    const cookie = await cookieFor(owner.id);
    const longTitle = "a".repeat(59) + " bbbb"; // autoSlugFromTitle -> "a" x59
    await db.insert(notes).values({ ownerId: owner.id, title: "occupier", slug: "a".repeat(59) });
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: longTitle } });
    const got = (await dbRow(db, note.id)).slug;
    expect(got).toBe("a".repeat(58) + "-2"); // 58 + '-2' = exactly 60
    expect(Array.from(got).length).toBeLessThanOrEqual(60);
    expect(validateSlug(got)).toBeNull();
  });

  it("statement shape guard: {slug} has no pre-check/pre-read, {title, slug:null} no pre-read, {slug:null} exactly one pre-read; each of the four request forms issues exactly one write statement", async () => {
    // "No uniqueness pre-check, a single UPDATE" is a load-bearing contract of the PATCH handler's JSDoc in routes/notes.ts that result-value tests can't pin
    // (adding a pre-check SELECT leaves everything green); so collect the SQL per request with a drizzle logger and verify its shape literally.
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // The gate must be swapped too: buildTestApp's default `new UserGate(db)` is bound to its own fresh database; swapping only db
    // would make session validation query another database (401).
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb) });
    const owner = await insertUser(db, { email: "owner-mx13@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shape" } })).json();

    // The UPDATE of these forms is wrapped in `patchSlugInTx` (`WITH o AS (... FOR UPDATE) UPDATE "notes" ...`), so "exactly one
    // statement writing notes" matches `with ... update "notes"`; it may add one redirect DELETE (only when the old slug was custom). `begin`/`commit` don't match.
    const updates = () => queries.filter(q => /^(with .* )?update "notes"/i.test(q.trim()));
    const redirectDeletes = () => queries.filter(q => /^delete from "note_redirects"/i.test(q.trim()));
    // pre-check/probe look like "select ... where owner_id and slug ="; a pre-read looks like "select title, slug_is_custom ... where id" - counted separately.
    const slugFilteredSelects = () => queries.filter(q => /^select/i.test(q.trim()) && /"slug"\s*=/.test(q));
    const preReads = () => queries.filter(q => /^select/i.test(q.trim()) && /slug_is_custom/.test(q) && !/"slug"\s*=/.test(q));

    // {slug}: no slug-predicate SELECT (no pre-check, no probe), exactly one UPDATE
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "shape-custom" } })).statusCode).toBe(200);
    expect(slugFilteredSelects()).toHaveLength(0);
    expect(preReads()).toHaveLength(0);
    expect(updates()).toHaveLength(1);
    expect(redirectDeletes()).toHaveLength(0); // old row is auto -> no prev written -> no redirect deleted

    // {title, slug:null}: no pre-read (title is in the request), exactly one UPDATE. Also self-validates slugFilteredSelects's regex:
    // this form must probe (a SELECT with a "slug" predicate); if drizzle changed its SQL rendering and the regex stopped matching,
    // this line fails first, so the "==0" of the first form doesn't silently become always true.
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shape Three", slug: null } })).statusCode).toBe(200);
    expect(preReads()).toHaveLength(0);
    expect(slugFilteredSelects().length).toBeGreaterThan(0);
    expect(updates()).toHaveLength(1);
    expect(redirectDeletes()).toHaveLength(1); // old row is the custom one set by the first form -> prev written -> same-path redirect deleted in the same transaction

    // {title}: exactly one pre-read (reads slug_is_custom), exactly one UPDATE
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Shape Two" } })).statusCode).toBe(200);
    expect(preReads()).toHaveLength(1);
    expect(updates()).toHaveLength(1);
    expect(redirectDeletes()).toHaveLength(0); // title-only writes no prev and opens no transaction

    // {slug:null}: exactly one pre-read (reads the current title), exactly one UPDATE
    queries.length = 0;
    expect((await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: null } })).statusCode).toBe(200);
    expect(preReads()).toHaveLength(1);
    expect(updates()).toHaveLength(1);
    expect(redirectDeletes()).toHaveLength(0); // old row is auto (set by the third form) -> no prev written
  });

  it("source guard: apart from schema.ts, no `legacySlug` assignment key in src/ (the frozen snapshot is written only by 0007)", () => {
    // The trigger is the structural defence (migrate.test guards it); this pins the app layer: an assignment key like `legacySlug:`
    // may appear only in schema.ts's column definition; anywhere else in src/ means someone is trying to write it.
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !p.endsWith(`db${path.sep}schema.ts`)) {
          if (/legacySlug\s*:/.test(readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("POST /api/notes - slug derivation at creation (#145)", () => {
  // All three creation paths derive the slug in notes/create.ts; this describe drives it through POST /api/notes (the createWithContent wiring is guarded in
  // note-create-content.test.ts; the PATCH-side matrix is the describe above).
  async function createdRow(db: Db, id: string) {
    const [row] = await db
      .select({ slug: notes.slug, slugIsCustom: notes.slugIsCustom, prevSlug: notes.prevSlug, legacySlug: notes.legacySlug })
      .from(notes)
      .where(eq(notes.id, id))
      .limit(1);
    return row!;
  }

  const post = (app: Awaited<ReturnType<typeof buildTestApp>>["app"], cookie: string, payload: object) =>
    app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload });

  it("with title -> slug follows the title (slug_is_custom=false, prev_slug not recorded)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-c1@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await post(app, cookie, { title: "Meeting Notes" });
    expect(res.statusCode).toBe(201);
    // The first assertion must be `slug` (not `title`): vitest aborts at the first failure, and in the wrong order a regression that
    // derives but doesn't pass slug into values would be reported at an unrelated assertion.
    expect(res.json().slug).toBe("meeting-notes");
    expect(res.json().title).toBe("Meeting Notes");
    // Creation isn't "the user explicitly set a URL": `slug_is_custom` must stay false (so later title PATCHes keep recomputing),
    // and prev_slug/legacy_slug stay empty.
    expect(await createdRow(db, res.json().id)).toMatchObject({
      slug: "meeting-notes",
      slugIsCustom: false,
      prevSlug: null,
      legacySlug: null,
    });
  });

  it("without title -> still takes the DB default `untitled-<8hex>`, **not** derived into `untitled`", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-c2@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await post(app, cookie, {});
    expect(res.statusCode).toBe(201);
    // Catches "no derivation without title": a regression that also derives for title-less creates fails here, and this
    // line must come before the shape comparison below: under that regression the slug would be `untitled`, and failing first with
    // "must not equal untitled" points at the cause.
    expect(res.json().slug).not.toBe("untitled");
    expect(res.json().slug).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect((await createdRow(db, res.json().id)).slug).toBe(res.json().slug);
  });

  it("second note with the same title and owner gets -2 (both 201, never 409); the same name coexists across owners", async () => {
    const { app, db } = await buildTestApp();
    const a = await insertUser(db, { email: "owner-c3a@example.com" });
    const b = await insertUser(db, { email: "owner-c3b@example.com" });
    const cookieA = await cookieFor(a.id);
    const cookieB = await cookieFor(b.id);

    const first = await post(app, cookieA, { title: "Shared Title" });
    const second = await post(app, cookieA, { title: "Shared Title" });
    expect(first.statusCode).toBe(201);
    // 409 `slug_taken` is reserved for a user-specified custom slug colliding; the creation path must not use it.
    expect(second.statusCode).toBe(201);
    expect([first.json().slug, second.json().slug]).toEqual(["shared-title", "shared-title-2"]);

    // Uniqueness scope is (owner_id, slug): another owner can get the same name.
    const other = await post(app, cookieB, { title: "Shared Title" });
    expect(other.statusCode).toBe(201);
    expect(other.json().slug).toBe("shared-title");
  });

  it("title with no usable URL form (punctuation only/uuid) -> `untitled`, second one `untitled-2`", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-c4@example.com" });
    const cookie = await cookieFor(owner.id);

    // `titleSlug` filters to empty -> `autoSlugFromTitle` falls back to `"untitled"` (**no suffix**).
    const punct = await post(app, cookie, { title: "###" });
    expect(punct.statusCode).toBe(201);
    expect(punct.json().slug).toBe("untitled");
    // Boundary: the fallback is `untitled`, **not** the `untitled-<8hex>` of the title-less path.
    expect(punct.json().slug).not.toMatch(/^untitled-[0-9a-f]{8}$/);

    // A uuid-like title (the `validateSlug` uuid_like branch) falls back the same way, and the fallback **also dedupes**.
    const uuidish = await post(app, cookie, { title: "f47ac10b-58cc-4372-a567-0e02b2c3d479" });
    expect(uuidish.statusCode).toBe(201);
    expect(uuidish.json().slug).toBe("untitled-2");
  });

  it("statement shape guard: create with title issues exactly 1 probe SELECT + 1 INSERT; without title exactly 0 probes", async () => {
    // "No probe at all without a title" is a load-bearing contract of this rule and the default comment in `db/schema.ts`; result-value
    // tests can't pin statement shape (an extra probe stays green). Collect SQL per request with a drizzle logger and check the shape.
    const { pool, db } = await freshDb();
    const queries: string[] = [];
    const loggedDb = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q) } }) as unknown as Db;
    // The gate must be swapped too (as in the four-form matrix case above): swapping only db makes session validation query another database -> 401.
    const { app } = await buildTestApp({ db: loggedDb, gate: new UserGate(loggedDb) });
    const owner = await insertUser(db, { email: "owner-c5@example.com" });
    const cookie = await cookieFor(owner.id);

    const probes = () => queries.filter(q => /^select/i.test(q.trim()) && /"slug"\s*=/.test(q));
    const noteInserts = () => queries.filter(q => /^insert into "notes"/i.test(q.trim()));

    // Order is part of the assertion: the "exactly 1" half goes first. If the probe regex stopped matching because drizzle changed its
    // rendering, the "exactly 0" half would silently become always true, and since vitest aborts at the first failure, a self-validating half placed later would never run.
    queries.length = 0;
    const withTitle = await post(app, cookie, { title: "Shape Create" });
    expect(withTitle.statusCode).toBe(201);
    expect(probes()).toHaveLength(1);
    expect(noteInserts()).toHaveLength(1);

    queries.length = 0;
    const without = await post(app, cookie, {});
    expect(without.statusCode).toBe(201);
    expect(probes()).toHaveLength(0);
    expect(noteInserts()).toHaveLength(1);
  });

  it("real INSERT race (noteCreateHooks hook): 5 collisions in a row, the 6th falls back to untitled-<uuid8>, never 409", async () => {
    // `beforeInsert` is called each round after the probe and before the INSERT: race-insert a placeholder with the same owner and
    // slug so the INSERT really hits the (owner_id, slug) unique index (the probe alone can't catch it). Same shape as the PATCH-side
    // sibling (the `slugUpdateTestHook` case).
    const hookCtx: { db?: Db; ownerId?: string } = {};
    const candidates: string[] = [];
    const beforeInsert = async (candidate: string) => {
      candidates.push(candidate);
      if (candidates.length <= 5 && hookCtx.db && hookCtx.ownerId) {
        await hookCtx.db.insert(notes).values({ ownerId: hookCtx.ownerId, title: "sniper", slug: candidate });
      }
    };
    const { app, db } = await buildTestApp({ noteCreateHooks: { beforeInsert } });
    const owner = await insertUser(db, { email: "owner-c6@example.com" });
    const cookie = await cookieFor(owner.id);
    hookCtx.db = db;
    hookCtx.ownerId = owner.id;

    const res = await post(app, cookie, { title: "Race Me" });
    expect(res.statusCode).toBe(201);
    // This line is not decoration: with `attempt > MAX_AUTO_SLUG_RETRIES` mutated to `>=`, the length, `[0]`, `[5]` and DB value
    // assertions all stay green (attempts 1..4 get race-me..race-me-4, all raced; attempt 5 falls back early and gets uuid8_a, also
    // raced; attempt 6 gets uuid8_b and succeeds, so length is still 6, `[0]` still race-me, `[5]` still uuid8-shaped). The difference
    // shows in `candidates[4]`, so it must be pinned and placed before the other four. The PATCH-side sibling has the same blind spot.
    expect(candidates.slice(0, 5)).toEqual(["race-me", "race-me-2", "race-me-3", "race-me-4", "race-me-5"]);
    expect(candidates).toHaveLength(6);
    expect(candidates[5]).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect((await createdRow(db, res.json().id)).slug).toBe(candidates[5]);
  });

  it("source guard: `.insert(notes)` may appear in src/ only in notes/create.ts", () => {
    // The type layer (removing the values-building function and its type, `createWithContent` taking `title`) blocks "changing only
    // one of the places in the existing shape", but not someone hand-writing `db.insert(notes).values({ownerId,title})` again, which is
    // still valid drizzle. This case is that side: a fourth creation path turns it red.
    //
    // Known blind spots (it doesn't guard everything): it only recognises the literal `.insert(notes)` on **non-comment lines**;
    // `insert(schema.notes)`, `db.execute(sql\`insert into notes ...\`)`, storing the table object in a local variable, or splitting
    // the call across lines all escape it; the comment filter only recognises line-leading forms (`//`, `/*`, `*`), so a literal in a
    // trailing comment still hits (deliberately conservative). **The exclusion is also a path-suffix match** (`notes${path.sep}create.ts`),
    // so any future `src/<x>/notes/create.ts` would be exempted too (same as the existing `legacySlug` guard's `db${path.sep}schema.ts`
    // form, reused deliberately rather than inventing a second kind). It guards the pattern that happened before - the next person
    // copying an existing creation path - not every workaround.
    // An empty `offenders` is also what a broken walk, extension filter or comment filter produces: after changing them, check that
    // dropping the `notes/create.ts` exemption reports that file.
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !p.endsWith(`notes${path.sep}create.ts`)) {
          readFileSync(p, "utf8")
            .split(/\r?\n/)
            .forEach((line, i) => {
              const trimmed = line.trimStart();
              if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
              if (line.includes(".insert(notes)")) offenders.push(`${p}:${i + 1}`);
            });
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe("GET /api/notes/by-path/:handle/:slug", () => {
  it("hit + normalization (handle case, slug case) + same shape: the response equals GET /api/notes/:id key by key", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-bp1@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (
      await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: { title: "Path Note" } })
    ).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie }, payload: { slug: "path-note" } });

    // Case variants resolve (handle is ASCII lowercase, slug goes through normalizeSlug)
    const upper = await app.inject({
      method: "GET",
      url: `/api/notes/by-path/${owner.handle.toUpperCase()}/PATH-NOTE`,
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(upper.statusCode).toBe(200);

    // Same toNoteDto as GET /api/notes/:id: the web app seeds the ["note", id] cache from the by-path result, and a different shape
    // would poison the cache. Deep compare key by key (updatedAt is the same row so the same value).
    const byId = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(upper.json()).toEqual(byId.json());
    expect(byId.json()).toMatchObject({ ownerHandle: owner.handle, slug: "path-note", slugIsCustom: true });
  });

  it("prev_slug lookup: exactly 1 hit -> 200; 0 hits -> 404; more than 1 hit for the same owner -> 404 (no guessing)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-bp2@example.com" });
    const cookie = await cookieFor(owner.id);
    const patch = (id: string, payload: object) =>
      app.inject({ method: "PATCH", url: `/api/notes/${id}`, cookies: { [SESSION_COOKIE]: cookie }, payload });
    const get = (path: string) =>
      app.inject({ method: "GET", url: `/api/notes/by-path/${owner.handle}/${path}`, cookies: { [SESSION_COOKIE]: cookie } });

    // Exactly 1: a custom->custom rename leaves one level of redirect
    const a = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    expect((await patch(a.id, { slug: "old-name" })).statusCode).toBe(200);
    expect((await patch(a.id, { slug: "new-name" })).statusCode).toBe(200); // prev = old-name
    const hit = await get("old-name");
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({ id: a.id, slug: "new-name", prevSlug: "old-name" });

    // 0 hits
    const missZero = await get("never-existed");
    expect(missZero.statusCode).toBe(404);

    // >1: two notes used the same name in turn -> the same prev -> the lookup is ambiguous, always 404.
    // Every PATCH in setup asserts 200: the slugPatch bucket allows 10 per 10 minutes and this case uses 6, so a future case hitting
    // the throttle fails here first instead of silently invalidating the fixture.
    const b = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    expect((await patch(a.id, { slug: "dup-name" })).statusCode).toBe(200);
    expect((await patch(a.id, { slug: "a-final" })).statusCode).toBe(200); // a.prev = dup-name
    expect((await patch(b.id, { slug: "dup-name" })).statusCode).toBe(200); // dup-name was released by a, so b can take it
    expect((await patch(b.id, { slug: "b-final" })).statusCode).toBe(200); // b.prev = dup-name
    const missMulti = await get("dup-name");
    expect(missMulti.statusCode).toBe(404);

    // 404 must be byte-identical in shape (security invariant: pinning only the code can't catch a diverging message). The current
    // implementation sends 0 and >1 through the same `length !== 1` exit so this line is always true: it stays as a forward guard that
    // bites if the two states are ever split into different branches/messages; the real cross-branch same-shape guard is the
    // permission case (role branch vs prev branch raw body equality).
    expect(missMulti.body).toBe(missZero.body);
  });

  it("shared user hits by-path with the **owner's** handle -> 200, role is their own, ownerHandle is the owner's", async () => {
    // The biggest semantic difference from :ref: the first URL segment is someone else's handle.
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-bp4@example.com" });
    const viewer = await insertUser(db, { email: "viewer-bp4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "viewer-bp4@example.com", role: "viewer" },
    });
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { slug: "shared-note" } });

    const res = await app.inject({
      method: "GET",
      url: `/api/notes/by-path/${owner.handle}/shared-note`,
      cookies: { [SESSION_COOKIE]: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: note.id, role: "viewer", ownerHandle: owner.handle });
  });

  it("no permission -> 404 (same shape against enumeration); a prev lookup hit also goes through resolveRole", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-bp3@example.com" });
    const stranger = await insertUser(db, { email: "stranger-bp3@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { slug: "secret-a" } });
    await app.inject({ method: "PATCH", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: ownerCookie }, payload: { slug: "secret-b" } });

    // Neither a current hit nor a prev hit may confirm existence to someone without permission, and the 404 must be byte-identical to
    // the one for a note that doesn't exist, so the caller gets no signal that it exists.
    const trueMiss = await app.inject({
      method: "GET",
      url: `/api/notes/by-path/${owner.handle}/definitely-not-a-note`,
      cookies: { [SESSION_COOKIE]: strangerCookie },
    });
    expect(trueMiss.statusCode).toBe(404);
    for (const path of ["secret-b", "secret-a"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/notes/by-path/${owner.handle}/${path}`,
        cookies: { [SESSION_COOKIE]: strangerCookie },
      });
      expect(res.statusCode, path).toBe(404);
      expect(res.body, path).toBe(trueMiss.body);
    }
  });
});

describe("#122 DTO backfill (ownerHandle/slugIsCustom/prevSlug)", () => {
  it("POST: ownerHandle = creator's handle (no extra lookup); slugIsCustom=false, prevSlug=null", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-dto1@example.com" });
    const cookie = await cookieFor(owner.id);
    const res = await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    expect(res.json()).toMatchObject({ ownerHandle: owner.handle, slugIsCustom: false, prevSlug: null });
  });

  it("GET list: both owned and shared branches carry the handle of **that note's owner**", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-dto2@example.com" });
    const me = await insertUser(db, { email: "me-dto2@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const myCookie = await cookieFor(me.id);
    const theirs = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${theirs.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "me-dto2@example.com", role: "viewer" },
    });
    const mine = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: myCookie }, payload: {} })).json();

    const list = (await app.inject({ method: "GET", url: "/api/notes", cookies: { [SESSION_COOKIE]: myCookie } })).json() as Array<{
      id: string;
      ownerHandle: string;
    }>;
    expect(list.find(n => n.id === mine.id)?.ownerHandle).toBe(me.handle);
    expect(list.find(n => n.id === theirs.id)?.ownerHandle).toBe(owner.handle); // shared branch = someone else's handle
  });

  it("GET /api/notes/:ref (uuid): carries ownerHandle", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-dto3@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    const res = await app.inject({ method: "GET", url: `/api/notes/${note.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.json()).toMatchObject({ ownerHandle: owner.handle });
  });

  it("editor PATCH title: the response's ownerHandle is the **owner's**, not the operator's (read separately after returning)", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-dto4@example.com" });
    const editor = await insertUser(db, { email: "editor-dto4@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: ownerCookie }, payload: {} })).json();
    await app.inject({
      method: "PUT",
      url: `/api/notes/${note.id}/shares`,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: { email: "editor-dto4@example.com", role: "editor" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/notes/${note.id}`,
      cookies: { [SESSION_COOKIE]: editorCookie },
      payload: { title: "Editor Was Here" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownerHandle).toBe(owner.handle);
    expect(res.json().ownerHandle).not.toBe(editor.handle);
  });
});

describe("resolveNoteAccess (notes/service.ts): the contract for personal notes (#175, replaces resolveRoleWithOwner)", () => {
  it("owner/editor get the real ownerId and their own permissions; none (stranger/nonexistent/invalid id) gets nothing", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-mx14@example.com" });
    const editor = await insertUser(db, { email: "editor-mx14@example.com" });
    const stranger = await insertUser(db, { email: "stranger-mx14@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = (await app.inject({ method: "POST", url: "/api/notes", cookies: { [SESSION_COOKIE]: cookie }, payload: {} })).json();
    await db.insert(noteShares).values({ noteId: note.id, userId: editor.id, role: "editor" });
    const none = { role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS };

    expect(await resolveNoteAccess(db, owner.id, note.id)).toEqual({ role: "owner", ownerId: owner.id, groupId: null, permissions: OWNER_PERMISSIONS });
    // The editor gets the **owner's** id (auto probing is scoped to the owner, not the operator)
    expect(await resolveNoteAccess(db, editor.id, note.id)).toEqual({ role: "editor", ownerId: owner.id, groupId: null, permissions: sharePermissions("editor") });
    expect(await resolveNoteAccess(db, stranger.id, note.id)).toEqual(none);
    expect(await resolveNoteAccess(db, owner.id, "00000000-0000-4000-8000-00000000dead")).toEqual(none);
    expect(await resolveNoteAccess(db, owner.id, "not-a-uuid")).toEqual(none);
  });
});
