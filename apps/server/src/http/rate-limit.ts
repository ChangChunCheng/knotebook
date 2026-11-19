// Fixed window per key (not sliding), no backoff (unlike `LoginThrottle`). The constants below are the only production defaults; http/limiters.ts reads them.
import { SITE_LIMITS } from "@knotebook/shared";
import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";


export const COLLAB_TOKEN_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const SLUG_PATCH_LIMIT = { limit: 10, windowMs: 600_000 } as const;
export const UPLOAD_LIMIT = { limit: SITE_LIMITS.rateUpload.default, windowMs: 600_000 } as const;
export const AI_LIMIT = { limit: SITE_LIMITS.rateAi.default, windowMs: 60_000 } as const;
// Login and callback each get their own limiter instance (#16): a shared one would charge two units per sign-in and halve the quota.
export const OIDC_LIMIT = { limit: 30, windowMs: 60_000 } as const;
export const REGISTER_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;
// GET is not limited (opening the share panel does a GET). Alias routes use `slugPatch`, width uses PUBLIC_WIDTH_LIMIT.
export const PUBLIC_LINK_LIMIT = { limit: 10, windowMs: 600_000 } as const;
// Charged after body parse and authorization; separate from publicLink so width clicks can't turn a revoke into a 429.
export const PUBLIC_WIDTH_LIMIT = { limit: 60, windowMs: 600_000 } as const;
// Public endpoints; token and alias forms share both limiters. Order in `resolvePublicNote`: format guard → isBlocked(ip) pre-check → DB lookup → consume miss only / hit only (hit vs miss is known only after the lookup).
// miss key = ip only: request input in the key would let an attacker mint fresh limiters. 120 because the key collapses behind a shared IP or a proxy without TRUST_PROXY (docs/known-limitations.md).
// hit keys of the two forms can't collide (a token has no ":"), so each form gets its own quota (accepted, docs/known-limitations.md).
export const PUBLIC_MISS_LIMIT = { limit: 120, windowMs: 60_000 } as const;
export const PUBLIC_NOTE_LIMIT = { limit: 60, windowMs: 60_000 } as const;
export const PUBLIC_UPLOAD_LIMIT = { limit: 300, windowMs: 60_000 } as const;

export interface FixedWindowLimiterOptions {
  limit: number | (() => number);
  windowMs: number;
  maxKeys?: number;
}

interface Window {
  windowStart: number;
  count: number;
}

// Always counts, even when over the limit. Eviction is BoundedMap insertion order: only opening a new window moves a key to the tail.
export class FixedWindowLimiter {
  private readonly limitOf: () => number;
  private readonly windowMs: number;
  private readonly windows: BoundedMap<Window>;

  constructor(opts: FixedWindowLimiterOptions) {
    const limit = opts.limit;
    this.limitOf = typeof limit === "function" ? limit : () => limit;
    this.windowMs = opts.windowMs;
    this.windows = new BoundedMap<Window>(opts.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  /** Read from the limiter itself because the MCP `copy_note` message names the limiter that rejected the request. */
  currentLimit(): number {
    return this.limitOf();
  }

  consume(key: string): boolean {
    return this.consumeTicket(key) !== null;
  }

  // Returns the window start so `refund` doesn't subtract from a newer window.
  consumeTicket(key: string): number | null {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.windowStart >= this.windowMs) {
      window = { windowStart: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.limitOf() ? window.windowStart : null;
  }

  // Takes nothing when short (consume's count-on-reject would let one rejected large copy eat the window's upload quota). n > limit is clamped
  // to a full empty window, else a note with more attachments than the quota could never be copied. Any reader of a note can copy its
  // attachments without paying upload quota, so new files per window are bounded only by attachment count and the edit limiter (docs/known-limitations.md).
  consumeMany(key: string, n: number): boolean {
    if (n <= 0) return true;
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.windowStart >= this.windowMs) {
      window = { windowStart: now, count: 0 };
      this.windows.set(key, window);
    }
    const limit = this.limitOf();
    const need = Math.min(n, limit);
    if (window.count + need > limit) return false;
    window.count += need;
    return true;
  }

  // Non-counting, so over-limit IPs are turned away before the DB query without being charged early.
  isBlocked(key: string): boolean {
    const window = this.windows.get(key);
    if (!window || Date.now() - window.windowStart >= this.windowMs) return false;
    return window.count >= this.limitOf();
  }

  // Refunds only if the key's current window is the ticket's; an expired or reopened window is left alone.
  refund(key: string, ticket: number): void {
    const window = this.windows.get(key);
    if (!window || window.windowStart !== ticket || window.count === 0) return;
    window.count -= 1;
  }

  retryAfterMs(key: string): number {
    const window = this.windows.get(key);
    if (!window) return 0;
    const left = window.windowStart + this.windowMs - Date.now();
    return left > 0 ? left : 0;
  }
}

export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

// Token path only: the session path is unlimited so web/e2e are unaffected. Charged after the scope check, so 403 insufficient_scope doesn't consume.
export const TOKEN_READ_LIMIT = { limit: SITE_LIMITS.rateTokenRead.default, windowMs: 60_000 } as const;
export const TOKEN_WRITE_LIMIT = { limit: SITE_LIMITS.rateTokenWrite.default, windowMs: 600_000 } as const;

// insufficient_scope doesn't consume (valid token); checkUser/mustChangePassword failures do (no token may represent that account).
// No isBlocked pre-check, so a valid token is never hurt by a bad client on the same IP; accepted cost: one UNIQUE index lookup per invalid Bearer even over the limit.
// ⚠ Without TRUST_PROXY everyone behind a proxy shares one limiter.
export const BEARER_MISS_LIMIT = { limit: 30, windowMs: 60_000 } as const;

// Same discipline as BEARER_MISS: charged on failure only. A 410 from concurrency inside the transaction doesn't consume (that request had a valid token).
export const ONE_TIME_LINK_MISS_LIMIT = { limit: 30, windowMs: 60_000 } as const;
// Charged only after a valid link is found and password login is on (the 403 doesn't consume, else re-enabling could mean waiting an hour); stops a link holder from making the server run argon2 on failing requests.
export const ONE_TIME_LINK_ATTEMPT_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;

export const PAT_CREATE_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;

// Looser than PAT_CREATE_LIMIT: rename/scope change issues no credential and is a single UPDATE.
export const TOKEN_RENAME_LIMIT = { limit: 60, windowMs: 600_000 } as const;

// 30/h, not stricter: without TRUST_PROXY everyone behind a proxy shares one limiter.
export const DCR_LIMIT = { limit: 30, windowMs: 3_600_000 } as const;

// Every request that passes parameter checks counts (no hit/miss: each one queries the DB).
export const AUTHORIZE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export const TOKEN_ENDPOINT_LIMIT = { limit: 60, windowMs: 60_000 } as const;

// Charged after the role check so 404s for role "none" don't consume. Tighter than TOKEN_READ_LIMIT: a content read forks the doc and mounts BlockNote.
export const CONTENT_READ_LIMIT = { limit: SITE_LIMITS.rateContentRead.default, windowMs: 60_000 } as const;

// Not shared with CONTENT_READ_LIMIT: search cost grows with the visible text, and sharing would let paged AI reads and sidebar typing starve each other.
export const SEARCH_LIMIT = { limit: SITE_LIMITS.rateSearch.default, windowMs: 60_000 } as const;

// Charged after the site-wide export slot is taken (transfer/export-slot.ts).
export const TRANSFER_EXPORT_LIMIT = { limit: SITE_LIMITS.rateTransferExport.default, windowMs: 3_600_000 } as const;

// Charged inside the queue, only when something will be written; zero regions, identical resends and deduped creates charge tokenRead instead.
export const TRANSFER_WRITE_LIMIT = { limit: SITE_LIMITS.rateTransferWrite.default, windowMs: 60_000 } as const;

// Charged after the role check; tighter than reads because every write forks, mounts BlockNote, opens a direct connection and persists.
export const EDIT_LIMIT = { limit: SITE_LIMITS.rateEdit.default, windowMs: 60_000 } as const;

// Not shared with `edit`: folder writes only change metadata, and edit's 30/min would stop a 31-note sidebar move at the 31st and eat that minute's AI-edit quota.
// 600/min fits ~300 moves plus an undo; larger selections stop at the 601st charge. MCP calls through a token are charged TOKEN_WRITE_LIMIT first and hit that one earlier.
export const FOLDER_LIMIT = { limit: 600, windowMs: 60_000 } as const;

// Not shared with `edit` (one row per toggle; a bulk removal would eat the AI-edit quota). PUT charges after parse and authorization; DELETE only when `:id` is a UUID. Fixed, not site-adjustable.
export const FAVORITE_LIMIT = { limit: 600, windowMs: 60_000 } as const;

// Not shared with `search`, so sidebar search and the add-member dialog can't starve each other. Not a privacy boundary (scope is already limited to emails the caller can see). 400s don't charge.
export const USER_SUGGEST_LIMIT = { limit: 60, windowMs: 60_000 } as const;

// Not shared with `upload`: each call is a server-side download of up to 10 s. Fixed, not site-adjustable; 404s before the charge don't consume.
export const AVATAR_REFRESH_LIMIT = { limit: 10, windowMs: 3_600_000 } as const;
