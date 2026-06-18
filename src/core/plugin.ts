// The Plugin interface — the single contract every domain module obeys.
//
// Plugins are the only domain layer in codemaster (ARCHITECTURE.md §5-L2). Each plugin
// owns one knowledge domain (TS, SCSS, i18n, schema, a framework adapter); its internal
// data structure is private. Plugins form a strict DAG: a plugin may declare `deps`,
// and the `PluginRegistry` validates the DAG at init (no cycles, all deps satisfied).
//
// Beyond the lifecycle bits below, each plugin defines its own public methods — there is
// no enforced superset like "every plugin has findUsages". Ops know which methods each
// plugin provides through TypeScript types; no runtime feature probing.

import type { RepoRelPath } from './brands.ts';
import type { ListView } from './list.ts';

/** An opaque per-plugin freshness fingerprint. Plugins compute their own (e.g. a hash
 *  of `(path, size, mtime)` tuples; a counter incremented on internal commit; etc.); the
 *  outside compares them by equality only. Used by the read-time freshness check (§3.5)
 *  to detect whether a plugin's state matches the working tree. */
export type FreshnessFingerprint = string;

/** Plugin lifecycle and identity. All plugins implement this; each plugin extends it
 *  with its own domain-specific public methods (kept off this interface — ops reach the
 *  plugin's full API through the typed handle obtained from `PluginRegistry.get<T>`). */
export interface Plugin {
  /** Plugin id, e.g. 'ts', 'scss', 'i18n', 'react-query'. Stable; used as the prefix
   *  in `SymbolId`s minted by this plugin, and the namespace in `plugin:<id>` debug
   *  traces. */
  readonly id: string;

  /** Plugin version string. Surfaced through `status()` (ARCHITECTURE.md §11) so an
   *  agent can tell which plugin build it is talking to; also part of the
   *  invalidation cue for any plugin-internal opt-in disk cache (see wishlist). */
  readonly version: string;

  /** Plugin ids this plugin depends on (its DAG edge set). The `PluginRegistry` resolves
   *  these to plugin instances and passes them to `init`. Cycles are refused. */
  readonly deps: readonly string[];

  /** Bind dependencies and warm any eager state. Called once per engine spin-up, in
   *  topological order across the DAG. A plugin may also stay fully lazy here and warm
   *  on its first public-method call. */
  init(deps: PluginRegistry): Promise<void>;

  /** Release resources (LS, watchers, file handles, …). Called once per engine
   *  disposal, in reverse-topological order. Must be idempotent. */
  dispose(): Promise<void>;

  /** Current freshness fingerprint for this plugin's data. The op-entry freshness check
   *  (§3.5 / §8) captures these at request entry and compares to the new values after
   *  any reindex. Must be cheap (a small string or hash). */
  freshness(): FreshnessFingerprint;

  /** Apply a changed-paths set to this plugin's state. The op-entry guard (§3.5 / §8)
   *  computes `changed` from `git diff --name-only` (or the mtime fallback) and calls
   *  this on every plugin it touches. The plugin filters to paths in its own domain
   *  (e.g. the `scss` plugin ignores `.ts`); returning quickly when none apply is
   *  correct. Must not produce or consume torn views — readers pinned to the old
   *  state must keep seeing the old state. */
  reindex(changed: readonly RepoRelPath[]): Promise<void>;

  /** Paths this plugin tracks but has not yet reindexed (e.g. queued for the next
   *  read, or skipped because the cost would blow the latency budget). Surfaces
   *  through `FreshnessNote.staleFiles`. Return empty when fully current. */
  pending(): readonly RepoRelPath[];

  /** OPTIONAL: a short, single-line annotation rendered beside this plugin in `status` — a place
   *  for a plugin to self-describe domain-specific state an agent should see (e.g. the `ts` plugin
   *  lists the tsconfigs whose programs it spans for cross-program usages, §11 / Task G). Cheap and
   *  side-effect-free; `undefined` when there is nothing extra to report. */
  statusDetail?(): string | undefined;

  /** OPTIONAL: the named registries this plugin owns and can `list` (e.g. the `react` plugin's
   *  `['components','hooks','dialogs']`, the `react-query` plugin's `['queries','mutations',
   *  'queryKeys']`). The generic `list` op (§11) enumerates these across the active plugins to
   *  route a `list {registry}` call to its owner — so a new framework plugin contributes
   *  registries by implementing this, with no edit to the op. Typed-optional, like
   *  `statusDetail` — never reflection on the plugin shape. Cheap and side-effect-free. */
  listRegistries?(): readonly string[];

  /** OPTIONAL: list one of this plugin's registries (a name from `listRegistries`). Proof-carrying
   *  (each entry ships its span + confidence + provenance — §3.2/§3.3). Called only for a registry
   *  this plugin claimed via `listRegistries`; an unclaimed name is the op's concern, not the
   *  plugin's. */
  list?(registry: string): ListView;
}

/** The plugin registry — composition root for one engine. Built at engine spin-up,
 *  topologically sorts plugins by `deps`, refuses cycles, and exposes typed lookup so a
 *  plugin (or an op) can obtain its dependency's full public API.
 *
 *  The lookup is typed by the **consumer's** declared interface — codemaster does no
 *  reflection on plugin shapes. A plugin author imports the dependency's `Plugin`
 *  extension type from its module and asks for it by id. */
export interface PluginRegistry {
  /** Fetch a plugin by id, typed as the consumer's declared interface. Throws if the
   *  plugin is not registered (which the DAG validation catches at init for declared
   *  `deps`; an undeclared lookup is a programming error). */
  get<T extends Plugin>(id: string): T;

  /** Whether a plugin with the given id is registered. */
  has(id: string): boolean;

  /** The set of plugin ids currently registered, topologically sorted. Used by
   *  `status` and by debug. */
  readonly ids: readonly string[];
}
