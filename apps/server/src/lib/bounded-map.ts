// Never reached at self-hosted scale, small enough that a flood can't run memory away.
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * Evicts the oldest-inserted entry (insertion order, not strict LRU: rewriting a key moves it to the tail, `get()`
 * doesn't reorder). The cap is exploitable (flooding can evict a blocked login backoff); the eviction order only raises
 * that bar: the account track records emails an attacker doesn't care about and the IP track is forgeable when `TRUST_PROXY=true`.
 * The real cost is argon2 per failed login. Residual risk: `docs/known-limitations.md`.
 */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly maxKeys: number) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      // Silently degrading to unbounded is the one unacceptable failure mode here; fail at startup instead.
      throw new RangeError(`BoundedMap: maxKeys 必須是 >= 1 的整數，收到 ${maxKeys}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, value);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }
}
