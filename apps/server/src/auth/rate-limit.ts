/**
 * Both maps are bounded. `recordFailure` rewrites its record (moves it to the tail), so eviction takes the key with the
 * oldest failure; evicting a blocked record needs maxKeys keys with newer failures, which are recorded too.
 */

import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";

interface FailureRecord {
  failureCount: number;
  lastFailureTime: number;
}

const MAX_BACKOFF_SECONDS = 900; // 15 minutes

/**
 * Keys come straight from the request: the account key is the submitted email (the login body schema only checks `z.string()`
 * because format validation would make 400/401 an account-existence oracle); the IP key is `X-Forwarded-For` when `TRUST_PROXY`
 * is set, else the socket address. Truncation bounds bytes (entry count alone doesn't: bodyLimit is 1 MiB). 320 exceeds the
 * 254-char email limit, so real input is never cut; oversized input collapses onto one record, which is intended.
 */
const MAX_KEY_LENGTH = 320;

const boundKey = (key: string): string => (key.length <= MAX_KEY_LENGTH ? key : key.slice(0, MAX_KEY_LENGTH));

export class LoginThrottle {
  private accountFailures: BoundedMap<FailureRecord>;
  private ipFailures: BoundedMap<FailureRecord>;
  private now: () => number;

  constructor(opts?: { now?: () => number; maxKeys?: number }) {
    this.now = opts?.now ?? (() => Date.now());
    const maxKeys = opts?.maxKeys ?? DEFAULT_MAX_KEYS;
    this.accountFailures = new BoundedMap<FailureRecord>(maxKeys);
    this.ipFailures = new BoundedMap<FailureRecord>(maxKeys);
  }

  checkAllowed(rawAccount: string, rawIp: string): {
    allowed: boolean;
    retryAfterMs?: number;
  } {
    const account = boundKey(rawAccount);
    const ip = boundKey(rawIp);
    const currentTime = this.now();

    const accountRetryAfterMs = this.evaluateRecord(
      this.accountFailures.get(account),
      currentTime
    );
    const ipRetryAfterMs = this.evaluateRecord(
      this.ipFailures.get(ip),
      currentTime
    );

    this.cleanupIdleRecord(this.accountFailures, account, currentTime);
    this.cleanupIdleRecord(this.ipFailures, ip, currentTime);

    const accountBlocked = accountRetryAfterMs !== undefined;
    const ipBlocked = ipRetryAfterMs !== undefined;
    const blocked = accountBlocked || ipBlocked;

    if (blocked) {
      const retryAfterMs = Math.max(
        accountRetryAfterMs ?? 0,
        ipRetryAfterMs ?? 0
      );
      return {
        allowed: false,
        retryAfterMs,
      };
    }

    return { allowed: true };
  }

  recordFailure(rawAccount: string, rawIp: string): void {
    const account = boundKey(rawAccount);
    const ip = boundKey(rawIp);
    const currentTime = this.now();

    // Always set() rather than mutating the record: it moves the key to the tail (see class comment above).
    this.accountFailures.set(account, {
      failureCount: (this.accountFailures.get(account)?.failureCount ?? 0) + 1,
      lastFailureTime: currentTime,
    });

    this.ipFailures.set(ip, {
      failureCount: (this.ipFailures.get(ip)?.failureCount ?? 0) + 1,
      lastFailureTime: currentTime,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  recordSuccess(account: string, _ip: string): void {
    this.accountFailures.delete(boundKey(account));
    // The IP counter is deliberately kept (it decays only through the idle timeout): otherwise logging into one's own account would reset the backoff of an IP guessing others.
  }

  private evaluateRecord(
    record: FailureRecord | undefined,
    currentTime: number
  ): number | undefined {
    if (!record || record.failureCount < 5) {
      return undefined;
    }

    const backoffMs = this.getBackoffMs(record.failureCount);

    const elapsedMs = currentTime - record.lastFailureTime;

    if (elapsedMs < backoffMs) {
      return Math.max(0, backoffMs - elapsedMs);
    }

    return undefined;
  }

  private cleanupIdleRecord(
    map: BoundedMap<FailureRecord>,
    key: string,
    currentTime: number
  ): void {
    const record = map.get(key);
    if (!record) {
      return;
    }

    const idleMs = currentTime - record.lastFailureTime;
    if (idleMs > MAX_BACKOFF_SECONDS * 1000) {
      map.delete(key);
    }
  }

  private getBackoffMs(failureCount: number): number {
    const exponent = failureCount - 4;
    const backoffSeconds = Math.pow(2, exponent);
    const cappedSeconds = Math.min(backoffSeconds, MAX_BACKOFF_SECONDS);
    return cappedSeconds * 1000;
  }
}
