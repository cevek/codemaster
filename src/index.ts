// Public programmatic API surface.
//
// The CLI/MCP facade is the primary way agents reach codemaster; this barrel exists
// for embedding and for the typed `codemaster.config.ts` helper.

export { defineConfig } from './config/config.js';
export type {
  CodemasterConfig,
  IndexConfig,
  I18nConfig,
  ScssConfig,
  SchemaConfig,
  AdapterConfig,
  OutputConfig,
  DaemonConfig,
  DebugConfig,
} from './config/config.js';

export type {
  RepoRelPath,
  Glob,
  RepoId,
  NodeId,
  IndexVersion,
  FileVersion,
} from './core/brands.js';

export type { JsonValue } from './core/json.js';

export type { Loc, Span, Confidence, Provenance } from './core/span.js';

export type {
  Fact,
  FreshnessNote,
  Truncation,
  ToolFailure,
  Result,
  Verbosity,
} from './core/result.js';

export type { SymbolId, SymbolKind, SymbolRef, HandleRebind } from './core/ids.js';

export type {
  NodeKind,
  EdgeKind,
  GraphNodeBase,
  FileNode,
  SymbolNode,
  JsxElementNode,
  ImportNode,
  CssClassNode,
  I18nKeyNode,
  AdapterNode,
  GraphNode,
  GraphEdge,
  Graph,
} from './core/graph.js';

export type { Adapter, AdapterRegistry } from './core/adapter.js';

export type { DebugNamespace, Debugger, DebugSystem, RequestStore } from './core/debug.js';

export type {
  Target,
  SearchQuery,
  SearchHit,
  Search,
  ResolveQuery,
  ResolveResult,
  MemberInfo,
  Resolve,
  RefKind,
  RefsQuery,
  RefSite,
  RefsResult,
  Refs,
  TraceQuery,
  TraceStep,
  Trace,
  ListQuery,
  ListEntry,
  List,
  EditRecipe,
  EditQuery,
  EditPreview,
  Edit,
  Request,
  RequestResult,
  Batch,
  Primitives,
} from './primitives/contracts.js';

export type { GraphStore, GraphDelta } from './index/store.js';

export type { ProjectHost } from './daemon/host.js';
