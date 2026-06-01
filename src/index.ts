// Public programmatic API surface.
//
// The CLI/MCP facade is the primary way agents reach codemaster; this barrel exists for
// (a) the typed `codemaster.config.ts` helper (`defineConfig` + the `CodemasterConfig`
// shapes), (b) host embedding scenarios where a process spawns the orchestrator
// in-process and wants typed access to the op dispatch envelope (`OpRequest` /
// `OpResult` / `DispatchError`), and (c) plugin authors who need the `Plugin` interface,
// `Result<T>`, brands, and proof types. It is **not** the agent-facing surface — that
// is `src/mcp/` and the three MCP tools (§11).

export { defineConfig } from './config/config.js';
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
} from './config/config.js';

export type { RepoRelPath, Glob, RepoId, FileVersion } from './core/brands.js';

export type { JsonValue } from './core/json.js';

export type { Loc, Span, Confidence, Provenance } from './core/span.js';

export type {
  Fact,
  FreshnessNote,
  Truncation,
  ToolFailure,
  OkResult,
  FailureResult,
  Result,
  Verbosity,
} from './core/result.js';

export type { SymbolId, SymbolKind, SymbolRef, HandleRebind } from './core/ids.js';

export type { Plugin, PluginRegistry, FreshnessFingerprint } from './core/plugin.js';

export type { DebugNamespace, Debugger, DebugSystem, RequestStore } from './core/debug.js';

export type { OpFlags, OpRequest, OpResult, DispatchError, Batch } from './ops/contracts.js';

export type { ProjectHost } from './daemon/host.js';
