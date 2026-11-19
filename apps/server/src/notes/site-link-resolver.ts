// User scope accepts a target only if the owner can see it (`resolveNoteAccess(owner).role !== "none"`); group scope only same-group targets, with no user check. `/n/` and `/g/` resolve redirects and prev_slug, `/notes/<ref>` legacy slugs. Trashed candidates → null, decided before `lookup` returns rather than by adding conditions to `where`/`byId`, which would change `resolveNotePath`'s lookup order (a trashed exact-slug hit would be filtered out and resolve to another note via redirects or prev_slug).
import { eq, sql } from "drizzle-orm";
import type { SiteLinkTarget, SiteNoteHref } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes, users } from "../db/schema.js";
import { groupNotePath, userNotePath } from "./redirects.js";
import { resolveNotePath, type PathRowSource } from "./resolve-path.js";
import { resolveNoteAccess } from "./service.js";
import { resolveNoteIdFromRef } from "./slug.js";

export type SiteLinkScope = { kind: "user"; userId: string } | { kind: "group"; groupId: string };

export interface SiteLinkResolver {
  resolve(href: string, parsed: SiteNoteHref): Promise<SiteLinkTarget | null>;
}

interface Row {
  id: string;
  title: string;
  groupId: string | null;
  alive: boolean;
}

export function createSiteLinkResolver(db: Db, scope: SiteLinkScope): SiteLinkResolver {
  const cols = () => ({ id: notes.id, title: notes.title, groupId: notes.groupId, alive: sql<boolean>`${notes.deletedAt} is null` });
  const rows: PathRowSource<Row> = {
    where: (cond, limit) => db.select(cols()).from(notes).leftJoin(users, eq(users.id, notes.ownerId)).where(cond).limit(limit),
    byId: async noteId => (await db.select(cols()).from(notes).where(eq(notes.id, noteId)).limit(1))[0],
  };

  async function candidate(parsed: SiteNoteHref): Promise<Row | undefined> {
    const p = parsed.path;
    if (p.kind === "n") return resolveNotePath(db, rows, eq(users.handle, p.handle), p.slug, userNotePath(p.handle, p.slug));
    if (p.kind === "g") return resolveNotePath(db, rows, eq(notes.groupId, p.groupId), p.slug, groupNotePath(p.groupId, p.slug));
    const id = await resolveNoteIdFromRef(db, p.ref);
    return id === null ? undefined : rows.byId(id);
  }

  async function lookup(parsed: SiteNoteHref): Promise<SiteLinkTarget | null> {
    const row = await candidate(parsed);
    if (!row) return null;
    if (!row.alive) return null;
    if (scope.kind === "group") return row.groupId === scope.groupId ? { id: row.id, title: row.title } : null;
    const access = await resolveNoteAccess(db, scope.userId, row.id);
    return access.role !== "none" ? { id: row.id, title: row.title } : null;
  }

  const memo = new Map<string, Promise<SiteLinkTarget | null>>();
  return {
    resolve(href, parsed) {
      let hit = memo.get(href);
      if (!hit) {
        hit = lookup(parsed);
        memo.set(href, hit);
      }
      return hit;
    },
  };
}
