// Namespaced, greppable, compact tracing — for the agents building codemaster.
// (ARCHITECTURE.md §13.)

/** Subsystem namespaces. `(string & {})` keeps literal autocomplete while still
 *  allowing adapter-specific names like `adapter:react-query`. */
export type DebugNamespace =
  | 'ipc'
  | 'daemon'
  | 'repo'
  | 'watcher'
  | 'index:structural'
  | 'index:scss'
  | 'index:i18n'
  | 'index:schema'
  | 'graph'
  | 'ls'
  | 'ls:resolve'
  | 'ls:refs'
  | 'primitive:search'
  | 'primitive:resolve'
  | 'primitive:refs'
  | 'primitive:trace'
  | 'primitive:list'
  | 'primitive:edit'
  | 'edit:plan'
  | 'edit:apply'
  | 'resync'
  | 'eviction'
  | 'snapshot'
  | 'format'
  | 'mcp'
  | (string & {});

/** A tagged logger for one namespace. No-ops — and never builds `data` — when the
 *  namespace is disabled, so it is free on the hot path. The current request's
 *  `req#N` (from `DebugSystem.requests`) is attached automatically. */
export interface Debugger {
  readonly ns: DebugNamespace;
  readonly enabled: boolean;
  /** Emit one event. `data` is lazy: the thunk runs only when `enabled`, and its
   *  entries are rendered as greppable `k=v` pairs. */
  (message: string, data?: () => Record<string, unknown>): void;
}

/** The slice of `AsyncLocalStorage` we depend on, declared structurally so this
 *  contract stays free of a Node import. The implementation backs it with a real
 *  `AsyncLocalStorage<{ id: number }>`. */
export interface RequestStore {
  getStore(): { id: number } | undefined;
  run<T>(store: { id: number }, callback: () => T): T;
}

/** Process-wide debug factory. */
export interface DebugSystem {
  /** Get (or create) the logger for a namespace. */
  ns(ns: DebugNamespace): Debugger;
  /** Whether a namespace is currently enabled (honors wildcards and `-` excludes). */
  isEnabled(ns: DebugNamespace): boolean;
  /** Hot-toggle at runtime (CLI/IPC). Spec like `ls:*,watcher,-eviction`. */
  configure(spec: string): void;
  /** All known namespaces — powers `status` / `debug:topics` self-description. */
  topics(): DebugNamespace[];
  /** Correlation-id store: every emitted line is tagged with the current `req#N`. */
  readonly requests: RequestStore;
}
