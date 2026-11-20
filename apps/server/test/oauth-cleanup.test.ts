/**
 * Each of the five DELETEs in `runOauthCleanup` is tested at its predicate boundary, each paired with a counterpart that must not be
 * deleted: a predicate missing half of its condition staying green is a recurring false-green shape in this project. Idle client:
 * last_used_at, not created_at; zombie client: created over 24 h ago and never exchanged a grant/code; expired request/code: only
 * expired ones; PAT: only PATs expired for over 30 days.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { OAUTH_APP_IDLE_DAYS } from "@knotebook/shared";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../src/db/schema.js";
import { runOauthCleanup } from "../src/oauth/cleanup.js";
import type { Db } from "../src/db/index.js";
import { freshDb, insertPasswordUser } from "./helpers.js";

// This family needs only db (no routes), so use freshDb instead of buildTestApp, saving building the whole app eight times.
// Use the existing `insertPasswordUser` (email from randomUUID, no unique-key collision).
async function createUser(db: Db): Promise<string> {
  return (await insertPasswordUser(db)).id;
}

describe("opportunistic cleanup", () => {
  it("idle client: unused for 30 days disappears together with its grant", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "stale",
        clientName: "Stale",
        redirectUris: ["http://127.0.0.1/cb"],
        lastUsedAt: sql`now() - interval '31 days'`,
      });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Stale",
        scope: "notes:read",
        accessTokenHash: "h1",
        refreshTokenHash: "r1",
        clientId: "stale",
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      await db.insert(oauthRequests).values({
        id: "req1",
        clientId: "stale",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        scope: "notes:read",
        expiresAt: sql`now() + interval '5 minutes'`,
      });
      await db.insert(oauthCodes).values({
        codeHash: "code1",
        clientId: "stale",
        userId,
        scope: "notes:read",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        expiresAt: sql`now() + interval '5 minutes'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(oauthClients)).toHaveLength(0);
      // CASCADE removes the three; unexpired request/code go too
      expect(await db.select().from(apiTokens)).toHaveLength(0);
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  // The idle criterion is last_used_at, and a successful Bearer authentication updates it too (touchLastUsed, #130): both timestamps
  // share semantics so a client in daily use isn't purged.
  it("idle client: spares clients with last_used_at within 30 days (even if created_at was 90 days ago)", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "active",
        clientName: "Active",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '90 days'`,
        // Tight boundary: 29 days rather than 1 hour (a threshold changed to something like 24h would fail)
        lastUsedAt: sql`now() - interval '29 days'`,
      });
      // Needs a grant, else it falls into the zombie-client condition and gets deleted: this case tests that idle-client delete doesn't over-delete.
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Active",
        scope: "notes:read",
        accessTokenHash: "active-h",
        refreshTokenHash: "active-r",
        clientId: "active",
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(oauthClients)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("OAUTH_APP_IDLE_DAYS is 30 (docs and CHANGELOG say 30 days)", () => {
    expect(OAUTH_APP_IDLE_DAYS).toBe(30);
  });

  it("idle client boundary is OAUTH_APP_IDLE_DAYS (+/-1 hour)", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      const edges = [
        { clientId: "edge-fresh", lastUsedAt: sql`now() - make_interval(days => ${OAUTH_APP_IDLE_DAYS}) + interval '1 hour'` },
        { clientId: "edge-stale", lastUsedAt: sql`now() - make_interval(days => ${OAUTH_APP_IDLE_DAYS}) - interval '1 hour'` },
      ];
      for (const { clientId, lastUsedAt } of edges) {
        await db.insert(oauthClients).values({
          clientId,
          clientName: clientId,
          redirectUris: ["http://127.0.0.1/cb"],
          lastUsedAt,
        });
        await db.insert(apiTokens).values({
          userId,
          kind: "oauth",
          name: clientId,
          scope: "notes:read",
          accessTokenHash: `${clientId}-h`,
          refreshTokenHash: `${clientId}-r`,
          clientId,
          accessExpiresAt: sql`now() + interval '1 day'`,
        });
      }

      await runOauthCleanup(db);

      const clients = await db.select({ id: oauthClients.clientId }).from(oauthClients);
      expect(clients.map(r => r.id)).toEqual(["edge-fresh"]);
      const grants = await db.select({ id: apiTokens.clientId }).from(apiTokens);
      expect(grants.map(r => r.id)).toEqual(["edge-fresh"]);
    } finally {
      await close();
    }
  });

  it("zombie client: created over 24 h ago with no grant/code disappears; one with a code stays", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      for (const clientId of ["zombie", "busy"]) {
        await db.insert(oauthClients).values({
          clientId,
          clientName: clientId,
          redirectUris: ["http://127.0.0.1/cb"],
          createdAt: sql`now() - interval '25 hours'`,
        });
      }
      await db.insert(oauthCodes).values({
        codeHash: "c1",
        clientId: "busy",
        userId,
        scope: "notes:read",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        expiresAt: sql`now() + interval '5 minutes'`,
      });

      await runOauthCleanup(db);

      const remaining = await db.select({ id: oauthClients.clientId }).from(oauthClients);
      expect(remaining.map(r => r.id)).toEqual(["busy"]);
    } finally {
      await close();
    }
  });

  it("zombie client: one with a grant also stays (the other half of the predicate)", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "granted",
        clientName: "Granted",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Granted",
        scope: "notes:read",
        accessTokenHash: "g1",
        refreshTokenHash: "gr1",
        clientId: "granted",
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(oauthClients)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("zombie client: spares clients created less than 24 h ago (just registered, authorization not finished)", async () => {
    const { db, close } = await freshDb();
    try {
      // Tight boundary: 23 hours (a threshold loosened to 1 hour would fail)
      await db.insert(oauthClients).values({
        clientId: "fresh",
        clientName: "Fresh",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '23 hours'`,
      });
      await runOauthCleanup(db);
      expect(await db.select().from(oauthClients)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // Zombie delete runs before expired-request/code delete, so a zombie whose only code just expired takes two rounds to clear.
  // Without this test the self-healing would only be a claim in a comment; moving the expired deletes before zombie delete would fail the first-round assertion.
  it("zombie vs expired-code order: with the only code expired, the client disappears on the second round", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "expiring",
        clientName: "Expiring",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      await db.insert(oauthCodes).values({
        codeHash: "expired-code",
        clientId: "expiring",
        userId,
        scope: "notes:read",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        expiresAt: sql`now() - interval '1 minute'`,
      });

      await runOauthCleanup(db);
      // Zombie delete sees the code still there and spares the client, then expired-code delete removes that code
      expect(await db.select().from(oauthClients)).toHaveLength(1);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);

      await runOauthCleanup(db);
      expect(await db.select().from(oauthClients)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("expired requests and codes disappear, unexpired ones stay", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({ clientId: "c", clientName: "C", redirectUris: ["http://127.0.0.1/cb"] });
      for (const [id, offset] of [
        ["old", "-1 minute"],
        ["new", "+5 minutes"],
      ] as const) {
        await db.insert(oauthRequests).values({
          id,
          clientId: "c",
          redirectUri: "http://127.0.0.1:1/cb",
          codeChallenge: "x".repeat(43),
          scope: "notes:read",
          expiresAt: sql`now() + interval '${sql.raw(offset)}'`,
        });
        await db.insert(oauthCodes).values({
          codeHash: id,
          clientId: "c",
          userId,
          scope: "notes:read",
          redirectUri: "http://127.0.0.1:1/cb",
          codeChallenge: "x".repeat(43),
          expiresAt: sql`now() + interval '${sql.raw(offset)}'`,
        });
      }

      await runOauthCleanup(db);

      expect((await db.select({ id: oauthRequests.id }).from(oauthRequests)).map(r => r.id)).toEqual(["new"]);
      expect((await db.select({ h: oauthCodes.codeHash }).from(oauthCodes)).map(r => r.h)).toEqual(["new"]);
    } finally {
      await close();
    }
  });

  it("PAT delete: only PATs expired over 30 days are removed; ones under 30 days and non-expiring ones stay", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(apiTokens).values([
        {
          userId,
          kind: "pat",
          name: "old",
          scope: "notes:read",
          accessTokenHash: "p1",
          accessExpiresAt: sql`now() - interval '31 days'`,
        },
        {
          userId,
          kind: "pat",
          name: "recent",
          scope: "notes:read",
          accessTokenHash: "p2",
          accessExpiresAt: sql`now() - interval '3 days'`,
        },
        { userId, kind: "pat", name: "forever", scope: "notes:read", accessTokenHash: "p3", accessExpiresAt: null },
      ]);

      await runOauthCleanup(db);

      const names = (await db.select({ name: apiTokens.name }).from(apiTokens)).map(r => r.name).sort();
      expect(names).toEqual(["forever", "recent"]);
    } finally {
      await close();
    }
  });

  // The `kind='pat'` half of PAT delete: an oauth grant whose access expired 31 days ago must **not** be removed (refresh never
  // expires, the authorization is still valid; only idle-client delete and revocation retire it).
  it("PAT delete spares an oauth grant whose access expired over 30 days ago", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "og",
        clientName: "OG",
        redirectUris: ["http://127.0.0.1/cb"],
        lastUsedAt: sql`now() - interval '1 hour'`,
      });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "OG",
        scope: "notes:read",
        accessTokenHash: "og1",
        refreshTokenHash: "ogr1",
        clientId: "og",
        accessExpiresAt: sql`now() - interval '31 days'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(apiTokens)).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
