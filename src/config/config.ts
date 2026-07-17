// Project configuration.
//
// Intentionally fat — every codebase has its own conventions — but fully typed,
// so `defineConfig` autocomplete doubles as the documentation. Every *section* is
// optional; enabling one may require its key fields (e.g. `i18n` needs `locales`,
// `schema` needs `entrypoint`). Paths and globs here are plain `string` for authoring
// ergonomics; the loader brands them (`RepoRelPath` / `Glob`) at the validation
// boundary. (ARCHITECTURE.md §10.)

import type { JsonValue } from '../core/json.ts';

export interface TsConfig {
  /** Globs of source files the `ts` plugin tracks. */
  include?: string[];
  ignore?: string[];
  /** Monorepo: explicit package roots, each carrying its own tsconfig. */
  packages?: string[];
  /** tsconfig to drive the LanguageService (autodetected when omitted). */
  tsconfig?: string;
  /** Pre-warm size guard (ARCHITECTURE.md §9): the source-file count above which a DEFAULT
   *  (navto) `search_symbol` refuses to warm the LanguageService — warming a huge multi-program
   *  fan-out risks OOM (kills the in-process daemon) and squats memory for a throwaway discovery
   *  query. Over it the op redirects to `symbols_overview` / `search_symbol {syntactic:true}`;
   *  `force:true` overrides per-call. Default 4000 (codemaster ~629 files passes; a monorepo that
   *  OOM'd was ~6076). Raise it for a big machine, lower it to redirect sooner. */
  searchWarmMaxFiles?: number;
}

export interface I18nConfig {
  /** Locale JSON files — the source of truth for keys. */
  locales: string[];
  /** Translation function names to track, e.g. ['t', 'i18n.t']. */
  functions?: string[];
  /** The module that EXPORTS the translation function / hook — a repo-relative path or any
   *  specifier the project uses (`@/lib/i18n`, resolved via tsconfig `paths`). When set, usage
   *  matching switches from by-NAME to by SYMBOL IDENTITY: a `t('…')` call counts iff its callee
   *  binding resolves (through import / alias / namespace / hook-destructure) to a function from
   *  THIS module — so a same-named `t` from another module no longer fabricates a usage, and a
   *  renamed destructure / namespace alias of the real function is now caught. Omitted → the
   *  by-name behaviour is kept (no regression for existing setups). */
  module?: string;
  /** The hook that RETURNS the translation function — e.g. `useTranslation` (so a
   *  `const { t } = useTranslation()`, incl. a renamed `{ t: x }`, is matched by identity).
   *  Requires `module` (the hook is anchored to it — a bare same-named hook is NOT matched). */
  hook?: string;
  /** Reserved opt-in for template-literal key resolution. Off by default — dynamic
   *  keys are flagged `dynamic`, never guessed (ARCHITECTURE.md §18). */
  templateLiterals?: boolean;
}

export interface ScssConfig {
  /** Globs for CSS-module stylesheets. */
  modules?: string[];
  /** How modules are imported. `default`: `import s from './x.module.scss'`. */
  importStyle?: 'default' | 'namespace';
}

export interface SchemaConfig {
  /** Generated d.ts describing the API surface (e.g. openapi-typescript output). */
  entrypoint: string;
  generator?: 'openapi-typescript' | 'custom';
}

/** Framework-plugin selection: either an id (e.g. 'react-query') or an id+options pair.
 *  Plugins not listed here may still be loaded by autodetection (`package.json` dep
 *  presence) unless explicitly disabled. */
export type PluginConfig = string | { id: string; options?: Record<string, JsonValue> };

export interface OutputConfig {
  verbosity?: 'terse' | 'normal' | 'full';
  defaultLimit?: number;
}

export interface DaemonConfig {
  /** Engine transport: `'in-process'` (default — one process, easy to debug) or `'process'`
   *  (one child process per workspace: isolation, own heap, killable, parallel). See
   *  ARCHITECTURE.md §2. */
  isolation?: 'in-process' | 'process';
  /** Evict an idle workspace engine after N minutes (memory guard, §9). */
  idleEvictionMinutes?: number;
  /** How often (seconds) the orchestrator `stat()`s each engine's `repoRoot` to detect
   *  vanished worktrees (path-existence eviction, §9). Default ~60. */
  pathExistenceSweepSeconds?: number;
  /** `process`-mode only: the child engine's heap ceiling (`--max-old-space-size`, MB, §9). A
   *  warm that exceeds it OOMs the child honestly — the daemon stays up — instead of the shared
   *  daemon (t-167395). Default ≥ Node's own ~4 GB, so a legitimately large repo isn't killed
   *  needlessly. Ignored in `in-process` mode. */
  maxOldSpaceMB?: number;
}

export interface DebugConfig {
  /** Namespaces to trace, e.g. ['plugin:ts:*', 'watcher', '-eviction']. Off when empty.
   *  Overridden by the CODEMASTER_DEBUG env var and runtime hot-toggle. */
  namespaces?: string[];
  /** Size cap for the rotating debug log, in megabytes. */
  logMaxMB?: number;
}

export interface CodemasterConfig {
  ts?: TsConfig;
  i18n?: I18nConfig;
  scss?: ScssConfig;
  schema?: SchemaConfig;
  /** Framework plugins to enable; autodetected (by `package.json` dep) when omitted. */
  plugins?: PluginConfig[];
  output?: OutputConfig;
  daemon?: DaemonConfig;
  debug?: DebugConfig;
}

/** Identity helper that gives full type-checking + autocomplete on the config
 *  object in `codemaster.config.ts`. */
export function defineConfig(config: CodemasterConfig): CodemasterConfig {
  return config;
}
