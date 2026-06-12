// The injectable watcher seam (§8, §16 determinism). The watcher is an OPTIMIZATION —
// it keeps plugins usually-fresh so the read-time check is normally a no-op; the
// correctness guarantee never rides on it (§3.5). Tests drive a fake implementation
// directly (`fileChanged` / `flush`) instead of awaiting real chokidar events.

export interface WatcherEvents {
  /** Debounced batch of changed paths, absolute. The engine canonicalizes and fans
   *  out to plugins. */
  onChanged(paths: readonly string[]): void;
  /** The watcher degraded (e.g. ENOSPC on Linux inotify limits, §19). The engine
   *  keeps running on read-time freshness alone and surfaces this through `status`. */
  onDegraded(reason: string): void;
}

export interface WatcherHandle {
  close(): Promise<void>;
}

export interface Watcher {
  /** Returns `undefined` when this watcher does not actually watch (the engine then
   *  reports `watcher=off` and leans fully on the read-time check — still correct). */
  watch(root: string, events: WatcherEvents): WatcherHandle | undefined;
}

/** For setups that want no watching at all (and as the safe default in tests). */
export const nullWatcher: Watcher = {
  watch: () => undefined,
};
