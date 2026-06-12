// Generic LRU map (ARCHITECTURE.md §5-L0.5). Backed by `Map`'s insertion-order
// iteration: a `get`/`set` re-inserts the key, so the first key in iteration order is
// always the least recently used. Used by the orchestrator's memory governor (§9) and
// anything else that needs bounded caching.

export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly capacity: number;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`LruMap capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.onEvict = onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Read without touching recency (inspection paths — `status`, debug). */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const evictedValue = this.entries.get(oldest.value) as V;
      this.entries.delete(oldest.value);
      this.onEvict?.(oldest.value, evictedValue);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Least-recently-used first. */
  *keysByRecency(): IterableIterator<K> {
    yield* this.entries.keys();
  }
}
