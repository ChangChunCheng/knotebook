// Pure: time is always passed in, so unit tests can replay fixed vectors.
// Buckets are UTC-aligned [start, end) and keep their newest backup. The 15-minute and hourly tiers
// skip the in-progress bucket, which will get a newer backup anyway; the daily tier includes today,
// or just after midnight it would cover only six days.

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BucketTier {
  sizeMs: number;
  count: number;
  includeCurrentBucket: boolean;
}

const TIERS: readonly BucketTier[] = [
  { sizeMs: FIFTEEN_MIN_MS, count: 4, includeCurrentBucket: false },
  { sizeMs: HOUR_MS, count: 6, includeCurrentBucket: false },
  { sizeMs: DAY_MS, count: 7, includeCurrentBucket: true },
];

/** Also right for UTC days: UTC midnights are multiples of `DAY_MS` in epoch ms. */
function bucketStart(epochMs: number, sizeMs: number): number {
  return Math.floor(epochMs / sizeMs) * sizeMs;
}

/** Only the 15-minute tier gates writing a backup; the other tiers only affect pruning. */
export function crossesFifteenMinuteBoundary(lastBackupAt: Date | null, now: Date): boolean {
  if (lastBackupAt === null) return true;
  return bucketStart(lastBackupAt.getTime(), FIFTEEN_MIN_MS) !== bucketStart(now.getTime(), FIFTEEN_MIN_MS);
}

function tierBucketStarts(tier: BucketTier, now: Date): number[] {
  const current = bucketStart(now.getTime(), tier.sizeMs);
  const newest = tier.includeCurrentBucket ? current : current - tier.sizeMs;
  const starts: number[] = [];
  for (let i = 0; i < tier.count; i += 1) {
    starts.push(newest - i * tier.sizeMs);
  }
  return starts;
}

/** Returns the original `Date` objects from `existing`, so callers can map them back to rows by identity. */
export function selectPrunable(existing: Date[], now: Date): Date[] {
  const keep = new Set<Date>();

  for (const tier of TIERS) {
    for (const start of tierBucketStarts(tier, now)) {
      const end = start + tier.sizeMs;
      let newest: Date | null = null;
      for (const d of existing) {
        const t = d.getTime();
        if (t < start || t >= end) continue;
        if (newest === null || t > newest.getTime()) newest = d;
      }
      if (newest !== null) keep.add(newest);
    }
  }

  return existing.filter(d => !keep.has(d));
}
