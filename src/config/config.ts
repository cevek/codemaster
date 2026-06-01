// Project configuration.
//
// Intentionally fat — every codebase has its own conventions — but fully typed,
// so `defineConfig` autocomplete doubles as the documentation. Every *section* is
// optional; enabling one may require its key fields (e.g. `i18n` needs `locales`,
// `schema` needs `entrypoint`). Paths and globs here are plain `string` for authoring
// ergonomics; the loader brands them (`RepoRelPath` / `Glob`) at the validation
// boundary. (ARCHITECTURE.md §10.)

import type { JsonValue } from '../core/json.js';

export interface TsConfig {
  /** Globs of source files the `ts` plugin tracks. */
  include?: string[];
  ignore?: string[];
  /** Monorepo: explicit package roots, each carrying its own tsconfig. */
  packages?: string[];
  /** tsconfig to drive the LanguageService (autodetected when omitted). */
  tsconfig?: string;
}

export interface I18nConfig {
  /** Locale JSON files — the source of truth for keys. */
  locales: string[];
  /** Translation function names to track, e.g. ['t', 'i18n.t']. */
  functions?: string[];
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
