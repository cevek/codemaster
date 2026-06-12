// Public programmatic API surface.
//
// The CLI/MCP facade is the primary way agents reach codemaster; this barrel exists for
// (a) the typed `codemaster.config.ts` helper (`defineConfig` + the `CodemasterConfig`
// shapes), (b) host embedding scenarios where a process spawns the orchestrator
// in-process and wants typed access to the op dispatch envelope (`OpRequest` /
// `OpResult` / `DispatchError`), and (c) plugin authors who need the `Plugin` interface,
// `Result<T>`, brands, and proof types. It is **not** the agent-facing surface — that
// is `src/mcp/` and the three MCP tools (§11).

export { defineConfig } from './config/config.ts';
export type {
  CodemasterConfig,
  TsConfig,
  I18nConfig,
  ScssConfig,
  SchemaConfig,
  PluginConfig,
  OutputConfig,
  DaemonConfig,
  DebugConfig,
} from './config/config.ts';

export type { RepoRelPath, Glob, RepoId, FileVersion } from './core/brands.ts';

export type { JsonValue } from './core/json.ts';

export type { Loc, Span, Confidence, Provenance } from './core/span.ts';

export type {
  Fact,
  FreshnessNote,
  Truncation,
  ToolFailure,
  OkResult,
  FailureResult,
  Result,
  Verbosity,
} from './core/result.ts';

export type { SymbolId, SymbolKind, SymbolRef, HandleRebind } from './core/ids.ts';

export type { Plugin, PluginRegistry, FreshnessFingerprint } from './core/plugin.ts';

export type { DebugNamespace, Debugger, DebugSystem, RequestStore } from './core/debug.ts';

export type { OpFlags, OpRequest, OpResult, DispatchError, Batch } from './ops/contracts.ts';

export type { ProjectHost } from './daemon/host.ts';

// ── Plugin/op authoring surface (consumed by plugin authors and the test harness) ──

export type {
  OpContext,
  OpDefinition,
  AnyOpDefinition,
  ColumnType,
  TableColumn,
  TableSpec,
  Cell,
} from './ops/registry.ts';
export { defineOp } from './ops/registry.ts';

export type { TsPluginApi, TsTargetInput, ResolvedTarget } from './plugins/ts/plugin.ts';
export type {
  SymbolView,
  UsageView,
  UsagesView,
  UsageOptions,
  GroupRow,
  TypeView,
} from './plugins/ts/query-types.ts';
export type { SearchFilter, SearchView } from './plugins/ts/search.ts';
export type { UsageRole } from './plugins/ts/usage-roles.ts';
export type { ImporterRow, ImportersView } from './plugins/ts/importers.ts';
export type { CssModuleAccess, CssModuleUsages } from './plugins/ts/css-modules.ts';
export type {
  ScssPluginApi,
  ScssClassView,
  UnusedClassView,
  UnusedScssView,
} from './plugins/scss/plugin.ts';

export type { Watcher, WatcherEvents, WatcherHandle } from './support/watch/seam.ts';
export type { DebugSink } from './support/debug/file-sink.ts';
export type { DebugSystemHandle, RequestOptions } from './support/debug/system.ts';
export type { MintResult } from './support/fs/canonicalize.ts';
export type { StatOutcome } from './support/fs/stat-fingerprint.ts';
export type { FileFingerprint } from './common/fingerprint/fingerprint.ts';
export type { DriftCheck, FreshnessMode } from './daemon/freshness.ts';
export type {
  StatusView,
  WorkspaceStatusView,
  PluginStatusView,
  OpStatusView,
} from './format/render/render-status.ts';
