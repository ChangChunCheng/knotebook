import { normalizeEmail } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { PIECE_RE, SEGMENT_SEPARATOR_RE } from "@/lib/email-list";

/**
 * No limit on batch size; `user_not_found` reveals whether an account exists and the server has no per-person throttle
 * (both in docs/known-limitations.md).
 */

/** Only rejects obvious non-emails; the server's zod `.email()` decides (a 400 `invalid_body` is also counted as invalid). */
const EMAIL_LIKE_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+$/;

/** Strips a quoted display name right before `<` (`"Lee, Ann" <ann@x.com>`), which may contain commas; a lone `"ann@x.com"` is untouched. */
const QUOTED_NAME_BEFORE_ANGLE_RE = /"[^"]*"\s*(?=<)/g;
const HAS_ANGLES_RE = /<[^<>]*>/;
// Segmenting (SEGMENT_SEPARATOR_RE) and in-segment pieces (PIECE_RE) live in lib/email-list.ts, shared with the add box's
// suggestions (UserEmailCombobox multiple).

/**
 * In a segment with `<…>` (`Name <address>` from a mail recipient field) everything inside brackets is taken and
 * email-like pieces outside are taken too (`a@x.com b@x.com Carol <c@x.com>` gives three); pieces without `@` are names,
 * skipped without error; pieces with `@` that don't look like email (`bob@@x.com`, `bob@`) are typos and go to `invalid`.
 * Dedup is case-insensitive, keeping the first spelling; `invalid` is deduped too and never sent. `all` = both in input order (to put addresses back in the box in their original order).
 * Unquoted `Lee, Ann <ann@x.com>` is unsupported: the comma splits first and `Lee` becomes invalid.
 */
export function parseEmailList(text: string): { emails: string[]; invalid: string[]; all: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const all: string[] = [];
  const seen = new Set<string>();
  for (const segment of text.replace(QUOTED_NAME_BEFORE_ANGLE_RE, "").split(SEGMENT_SEPARATOR_RE)) {
    const hasAngles = HAS_ANGLES_RE.test(segment);
    for (const match of segment.matchAll(PIECE_RE)) {
      const inAngles = match[1] !== undefined;
      const token = (match[1] ?? match[0]).trim().replace(/^[<"']+|[>"']+$/g, "");
      if (token.length === 0) continue;
      if (hasAngles && !inAngles && !token.includes("@")) continue;
      const key = normalizeEmail(token);
      if (seen.has(key)) continue;
      seen.add(key);
      (EMAIL_LIKE_RE.test(token) ? emails : invalid).push(token);
      all.push(token);
    }
  }
  return { emails, invalid, all };
}

/**
 * `notFound`: 404 `user_not_found`; `alreadyMember`: 409 `already_member` or already in the list before sending; `invalid`:
 * bad format (client check or server 400 `invalid_body`); `failed`: the one that stopped the batch; `notProcessed`: not sent
 * after a stop (error or Stop).
 */
export type BulkAddOutcome = "added" | "notFound" | "alreadyMember" | "invalid" | "failed" | "notProcessed";

export interface BulkAddResult {
  email: string;
  outcome: BulkAddOutcome;
}

export interface BulkAddReport {
  /** In send order. */
  results: BulkAddResult[];
  /** The error that stopped the batch (permission revoked, group gone, role deleted, 5xx, network error, proxy 429…); null if none. */
  stopped: { cause: unknown } | null;
  /** Stop pressed (or dialog closed, component unmounted): the in-flight request finishes, the rest are `notProcessed`. */
  cancelled: boolean;
}

/** Only per-item results continue; anything else stops the batch, so unknown errors don't push on. */
export function classifyAddError(err: unknown): Exclude<BulkAddOutcome, "added" | "failed" | "notProcessed"> | "stop" {
  if (!(err instanceof ApiFail)) return "stop";
  if (err.status === 404 && err.code === "user_not_found") return "notFound";
  if (err.status === 409 && err.code === "already_member") return "alreadyMember";
  if (err.status === 400 && err.code === "invalid_body") return "invalid";
  return "stop";
}

/** For the "add the rest later" hint on stop. The members route has no throttle, so a 429 can only come from a reverse proxy. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiFail && err.status === 429;
}

/**
 * Sequential, no batch endpoint: reuses the single-add transaction, permissions and 409 guard, and one at a time is what
 * allows stopping and reporting progress. `onProgress(processed, total)` runs after each item (added or skipped). An error
 * classified as `stop` marks that item `failed`, the rest `notProcessed`, and returns `stopped`. `signal` is checked before
 * each send; once aborted the rest are `notProcessed` with `cancelled: true`. The request already in flight isn't aborted:
 * it is already sent, and only its response tells whether the member was added.
 */
export async function runBulkAdd(
  emails: readonly string[],
  add: (email: string) => Promise<unknown>,
  onProgress?: (processed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<BulkAddReport> {
  const results: BulkAddResult[] = [];
  const rest = (from: number) => emails.slice(from).map((email) => ({ email, outcome: "notProcessed" as const }));
  for (const [index, email] of emails.entries()) {
    if (signal?.aborted) return { results: [...results, ...rest(index)], stopped: null, cancelled: true };
    try {
      await add(email);
      results.push({ email, outcome: "added" });
    } catch (err) {
      const kind = classifyAddError(err);
      if (kind === "stop") {
        results.push({ email, outcome: "failed" });
        return { results: [...results, ...rest(index + 1)], stopped: { cause: err }, cancelled: false };
      }
      results.push({ email, outcome: kind });
    }
    onProgress?.(index + 1, emails.length);
  }
  return { results, stopped: null, cancelled: false };
}
