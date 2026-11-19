// Pure: time is passed in (version-policy.test.ts guards this source against reading the clock).
// UTC day/week buckets are by design (docs/versions.md); a negative age (clock went back) falls in keep-all.
export interface VersionPolicyRow {
  seq: number;
  kind: string;
  createdAt: Date;
}

export interface VersionPolicyOpts {
  now: Date;
  keepAllDays: number;
  dailyUntilDays: number;
  baseSeq: number | null;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** The epoch was a Thursday; offsetting 4 days aligns weeks to Monday 00:00 UTC. */
const MONDAY_EPOCH_OFFSET_MS = 4 * DAY_MS;

const dayKey = (t: number): number => Math.floor(t / DAY_MS);
const weekKey = (t: number): number => Math.floor((t - MONDAY_EPOCH_OFFSET_MS) / WEEK_MS);
const newer = (a: VersionPolicyRow, b: VersionPolicyRow): boolean =>
  a.createdAt.getTime() > b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.seq > b.seq);

export function selectVersionsToDelete(rows: VersionPolicyRow[], opts: VersionPolicyOpts): number[] {
  if (rows.length === 0) return [];
  const newestSeq = rows.reduce((m, r) => (r.seq > m ? r.seq : m), rows[0]!.seq);
  const nowMs = opts.now.getTime();
  const keepAllMs = opts.keepAllDays * DAY_MS;
  const dailyUntilMs = opts.dailyUntilDays * DAY_MS;
  const keep = new Set<number>();
  const daily = new Map<number, VersionPolicyRow>();
  const weekly = new Map<number, VersionPolicyRow>();
  for (const r of rows) {
    if (r.kind === "manual" || r.seq === opts.baseSeq || r.seq === newestSeq) {
      keep.add(r.seq);
      continue;
    }
    const t = r.createdAt.getTime();
    const age = nowMs - t;
    if (age < keepAllMs) {
      keep.add(r.seq);
      continue;
    }
    const [bucket, key] = age < dailyUntilMs ? [daily, dayKey(t)] : [weekly, weekKey(t)];
    const cur = bucket.get(key);
    if (cur === undefined || newer(r, cur)) bucket.set(key, r);
  }
  for (const r of daily.values()) keep.add(r.seq);
  for (const r of weekly.values()) keep.add(r.seq);
  return rows.filter(r => !keep.has(r.seq)).map(r => r.seq).sort((a, b) => a - b);
}
