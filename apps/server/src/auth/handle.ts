import { eq, sql } from "drizzle-orm";
import type pino from "pino";
import { normalizeHandle } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { handles } from "../db/schema.js";

// The `handles` registry PK is the only arbiter of uniqueness; the DB probe in `deriveHandle` is an availability check, so the
// write can still collide. Retry contracts: bootstrap doesn't retry (fails closed); OIDC retries the whole tx once; register and
// accept-invite rerun the tx up to 3 times, then use `user-<uuid8>`. Re-probing on retry fixes a real `handles_pkey` race; the
// `users_handle_unique` window case is a deterministic re-collision (see the call sites).

const UUID_FORM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Probe cost is O(same-prefix count) index queries on an unthrottled path, so it must be bounded. */
const PROBE_LIMIT = 20;

type HandleQueryer = Pick<Db, "select">;

/** UUID-shaped bases are rejected before the 30-char truncation (afterwards a uuid prefix no longer looks like one). */
export function handleCandidateFrom(raw: string): string | null {
  let base = normalizeHandle(raw)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base === "" || UUID_FORM_RE.test(base)) return null;
  base = base.slice(0, 30).replace(/-+$/, "");
  return base === "" ? null : base;
}

async function isTaken(q: HandleQueryer, handle: string): Promise<boolean> {
  const [row] = await q.select({ handle: handles.handle }).from(handles).where(eq(handles.handle, handle)).limit(1);
  return row !== undefined;
}

export async function deriveHandle(
  q: HandleQueryer,
  candidates: Array<string | null | undefined>,
  userId: string,
): Promise<string> {
  const fallback = `user-${userId.slice(0, 8)}`;

  let base: string | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    base = handleCandidateFrom(candidate);
    if (base !== null) break;
  }
  if (base === null) return fallback;

  let cand = base;
  let n = 1;
  while (await isTaken(q, cand)) {
    n += 1;
    if (n > PROBE_LIMIT) return fallback;
    const suffix = `-${n}`;
    cand = base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
  }
  return cand;
}

/** Must run before `app.listen`, or the backfill can interleave with the first rename (call order is pinned by `handle.test.ts`). Warns only for users still lacking a live row afterwards: the conflict count can't be used because `DO NOTHING` swallows already-backfilled rows on every restart. */
export async function backfillHandleRegistry(db: Db, logger: pino.Logger): Promise<void> {
  // Released rows are leftovers an old server wrote during a rollback window; the registry must hold only live rows.
  const purged = await db.execute(sql`DELETE FROM handles WHERE state = 'released'`);
  if ((purged.rowCount ?? 0) > 0) {
    logger.info({ purged: purged.rowCount }, "handle registry 補登前清掉 released 列（rollback 到舊版 server 的窗期內改名留下的）");
  }
  await db.execute(
    sql`INSERT INTO handles (handle, user_id, state) SELECT handle, id, 'live' FROM users ON CONFLICT (handle) DO NOTHING`,
  );
  const missing = await db.execute(
    sql`SELECT u.id, u.handle FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM handles h WHERE h.handle = u.handle AND h.user_id = u.id AND h.state = 'live')`,
  );
  if (missing.rows.length > 0) {
    logger.warn(
      { users: missing.rows },
      "handle registry 補登後仍有使用者缺 live 對應列（名字被他人的 live 列占住）——這些使用者的 handle 未進 registry",
    );
  }
}
