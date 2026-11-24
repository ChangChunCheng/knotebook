import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { UUID_RE } from "../notes/service.js";

const USER_TOKEN_PREFIX = "user:";
// Same charset as handles: anything else names no one, and keeping it out of the query keeps NUL and lone surrogates out of a text parameter.
const HANDLE_TOKEN_RE = /^[a-z0-9-]+$/;

/**
 * Shared by `/api/users/suggest` and member resolution so that the people a writer can pick and the people a handle resolves to
 * stay the same set. May include `userId`; disabled accounts are not filtered out.
 */
export function knownUserIdsSql(userId: string): SQL {
  return sql`
    select other.user_id as id
      from group_members mine
      join group_members other on other.group_id = mine.group_id
     where mine.user_id = ${userId}
    union
    select ns.user_id as id
      from notes n
      join note_shares ns on ns.note_id = n.id
     where n.owner_id = ${userId}
       and n.deleted_at is null
  `;
}

/**
 * Token (lowercased handle or `user:<id>`) → user id, only for the writer and the people `/api/users/suggest` would offer them;
 * disabled accounts excluded. A token outside that reach is simply absent, the same as one naming nobody, so callers cannot
 * tell the two apart.
 */
export async function resolveKnowledgeMemberTokens(db: DbOrTx, writerId: string, tokens: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const handles = new Set<string>();
  const ids = new Set<string>();
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    if (HANDLE_TOKEN_RE.test(token)) handles.add(token);
    // Checked before the query: a malformed id would make the uuid cast fail the whole statement.
    else if (token.startsWith(USER_TOKEN_PREFIX) && UUID_RE.test(token.slice(USER_TOKEN_PREFIX.length))) ids.add(token.slice(USER_TOKEN_PREFIX.length));
  }
  if (handles.size === 0 && ids.size === 0) return out;
  const res = await db.execute<{ id: string; handle: string }>(sql`
    with known as (
      ${knownUserIdsSql(writerId)}
      union
      select ${writerId}::uuid as id
    )
    select u.id, u.handle
      from known k
      join users u on u.id = k.id
     where u.disabled_at is null
       and (u.handle = any(${sql.param([...handles])}::text[]) or u.id = any(${sql.param([...ids])}::uuid[]))
  `);
  for (const r of res.rows) {
    if (handles.has(r.handle)) out.set(r.handle, r.id);
    if (ids.has(r.id)) out.set(`${USER_TOKEN_PREFIX}${r.id}`, r.id);
  }
  return out;
}

/** User id → handle for any existing user, disabled included. Keys are the ids as given, whatever their case. */
export async function knowledgeMemberHandles(db: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  const users = await knowledgeMemberUsers(db, ids);
  return new Map([...users].map(([id, u]) => [id, u.handle]));
}

/** Like `knowledgeMemberHandles`, with the display name. */
export async function knowledgeMemberUsers(db: DbOrTx, ids: readonly string[]): Promise<Map<string, { id: string; handle: string; displayName: string }>> {
  const out = new Map<string, { id: string; handle: string; displayName: string }>();
  // Stored values come from collab state, which is untrusted: anything not shaped like a uuid names no one.
  const wanted = [...new Set(ids)].filter(id => UUID_RE.test(id));
  if (wanted.length === 0) return out;
  const res = await db.execute<{ id: string; handle: string; display_name: string }>(sql`
    select u.id, u.handle, u.display_name
      from users u
     where u.id = any(${sql.param([...new Set(wanted.map(id => id.toLowerCase()))])}::uuid[])
  `);
  const byId = new Map(res.rows.map(r => [r.id, { id: r.id, handle: r.handle, displayName: r.display_name }]));
  for (const id of wanted) {
    const u = byId.get(id.toLowerCase());
    if (u !== undefined) out.set(id, u);
  }
  return out;
}
