import type { Result, Fact, Verbosity } from '../core/result.js';
import type { Loc, Span, Confidence, Provenance } from '../core/span.js';
import type { SymbolId, SymbolRef } from '../core/ids.js';
import type { Glob, RepoRelPath } from '../core/brands.js';
import type { JsonValue } from '../core/json.js';

// The six universal verbs — the "lego". Everything higher-level (recipes) is composed
// from these. Each is proof-carrying and honest about uncertainty. (ARCHITECTURE §5 L3.)
//
// Every verb returns `Result<T>`; when a passed `SymbolId` was rebound or lost, that is
// reported uniformly on `Result.handle` — see `core/ids.ts` (§6). For many requests in
// one round-trip, see `Batch` at the bottom.

/** A target can be a stable handle or a raw location. */
export type Target = SymbolId | { file: RepoRelPath; line: number; col: number };

// ── search ─────────────────────────────────────────────────────────────────
// Structural tier. `mode: 'text'` is the only mode guaranteed ⊇ ripgrep.
export interface SearchQuery {
  mode: 'symbol' | 'text' | 'jsx';
  query: string;
  regex?: boolean;
  /** Restrict to files matching these globs. */
  scope?: Glob[];
  kind?: SymbolRef['kind'][];
  /** JSX filters (mode: 'jsx'): tag and attribute predicates. `value: true` means
   *  "attribute present, any value". */
  jsx?: { tag?: string; props?: Array<{ name: string; value?: string | true }> };
  /** Import filter: restrict to import sites, optionally type-only vs runtime. */
  imports?: { typeOnly?: boolean };
  includeComments?: boolean;
  verbosity?: Verbosity;
  limit?: number;
}
/** Structural-tier hits are exact matches against the syntactic index, so they carry no
 *  `confidence` — they are `certain` by construction (semantic uncertainty shows up in
 *  `resolve`/`refs`/`trace`, not here). */
export type SearchHit = SymbolRef & { signature?: string; preview?: Span };
export type Search = (q: SearchQuery) => Promise<Result<SearchHit[]>>;

// ── resolve ────────────────────────────────────────────────────────────────
// Always answered from the live LanguageService — ground truth, never a cached type.
export interface ResolveQuery {
  target: Target;
  want: Array<'type' | 'signature' | 'members' | 'docs'>;
  /** Assignability check: is `target` assignable to `assignableTo`? */
  assignableTo?: Target;
}
export interface MemberInfo {
  name: string;
  type: string;
  /** The base/extends/union origin, for inherited members. */
  from?: string;
}
export interface ResolveResult {
  type?: Fact<string>;
  signature?: Fact<string>;
  members?: Fact<MemberInfo[]>;
  docs?: string;
  assignable?: Fact<{ ok: boolean; conflictAt?: Span }>;
}
export type Resolve = (q: ResolveQuery) => Promise<Result<ResolveResult>>;

// ── refs ───────────────────────────────────────────────────────────────────
// Semantic find-usages via the TS LS (the oracle), not textual.
/** How a symbol is used at a site. `impl` = implementations/subtypes (a distinct LS
 *  call — `getImplementationAtPosition` / type hierarchy — not `findReferences`). */
export type RefKind = 'call' | 'jsx' | 'import' | 'type' | 'write' | 'read' | 'impl';
export interface RefsQuery {
  target: Target;
  /** Facet results by use kind. */
  kinds?: RefKind[];
  /** When true, only `files` is populated (the cheap projection). */
  filesOnly?: boolean;
  scope?: Glob[];
  limit?: number;
}
export interface RefSite {
  loc: Span;
  kind: RefKind;
  /** A ref reached through a dynamic/partial position (a re-export chain the LS can't
   *  fully resolve, a usage behind `any`) is flagged here rather than dropped. */
  confidence: Confidence;
}
/** Single return shape — no flag-keyed union. `files` is always present (the distinct
 *  files); `sites` is omitted when `filesOnly` was requested. */
export interface RefsResult {
  files: RepoRelPath[];
  sites?: RefSite[];
}
export type Refs = (q: RefsQuery) => Promise<Result<RefsResult>>;

// ── trace ──────────────────────────────────────────────────────────────────
// Control- and data-flow. A dynamic hop is flagged on the step, never silently bridged.
export interface TraceQuery {
  kind: 'control' | 'data' | 'prop' | 'invalidation' | 'widening';
  from: Target;
  /** Data-flow sink: 'render' | 'mutation' | 'cacheKey' | 'http', or a symbol. */
  to?: string;
}
export interface TraceStep {
  loc: Span;
  label: string;
  /** The hop type, e.g. 'mapper', 'queryKey', 'prop', 'callback'. */
  via?: string;
  /** Per-hop confidence — pins *which* step is dynamic/partial, not just the path. */
  confidence: Confidence;
  /** How this hop was derived (type-resolved vs adapter heuristic + which) — so a
   *  heuristic bridge is never mistaken for a proven edge. */
  provenance?: Provenance;
}
/** The `Fact`-level confidence is the aggregate (worst-of) across the steps. */
export type Trace = (q: TraceQuery) => Promise<Result<Fact<TraceStep[]>>>;

// ── list ───────────────────────────────────────────────────────────────────
// Domain registries, contributed by framework adapters via the `AdapterRegistry`
// (core/adapter.ts) — `list` reads the graph + registry, never a concrete adapter.
export interface ListQuery {
  registry:
    | 'dialogs'
    | 'sheets'
    | 'drawers'
    | 'forms'
    | 'routes'
    | 'mutations'
    | 'queries'
    | 'stores'
    | 'endpoints'
    | (string & {});
  filter?: string;
  limit?: number;
}
/** A registry entry. Like every other fact it carries its proof (`loc`, optionally the
 *  full `proof` span) and — since registry data is adapter/heuristic-derived — its
 *  `provenance`; `list` is no exception to §3.2/§3.3. `attrs` holds the adapter-specific
 *  fields (a route's path, a store's keys, …). */
export interface ListEntry {
  name: string;
  loc: Loc;
  proof?: Span;
  provenance?: Provenance;
  attrs?: Record<string, JsonValue>;
}
export type List = (q: ListQuery) => Promise<Result<ListEntry[]>>;

// ── edit ───────────────────────────────────────────────────────────────────
// Dry-run first; JSON recipes; schema-validated; git-aware; atomic.
// Two distinct families (ARCHITECTURE.md §7):
//   symbol-anchored  → resolved through the LS, edits its semantic refs
//   shape-based      → ast-grep pattern, never claims to target a symbol
export type EditRecipe =
  | { op: 'renameSymbol'; target: SymbolId; to: string }
  | { op: 'moveFile'; from: RepoRelPath; to: RepoRelPath }
  | { op: 'extractSymbol'; symbol: string; from: RepoRelPath; to: RepoRelPath }
  | { op: 'changeSignature'; target: SymbolId; from: string; to: string; callerTransform?: string }
  | { op: 'codemod'; pattern: string; rewrite: string; scope?: Glob[] };

export interface EditQuery {
  recipe: EditRecipe | EditRecipe[];
  /** Default false → dry-run preview (zero writes). */
  apply?: boolean;
}
export interface EditPreview {
  /** Unified diff of the full result. */
  diff: string;
  touched: RepoRelPath[];
  typecheck: 'clean' | { errors: Span[] };
  warnings?: string[];
}
export type Edit = (q: EditQuery) => Promise<Result<EditPreview>>;

// ── batch ──────────────────────────────────────────────────────────────────
// One round-trip, many requests: an agent that already knows what it needs sends the
// whole list and gets every result back at once. Reads run concurrently against ONE
// consistent graph version (§8); any `edit`s run last and serially. A single failed
// request becomes an `error` entry — it never aborts the batch.
export type Request =
  | { op: 'search'; query: SearchQuery }
  | { op: 'resolve'; query: ResolveQuery }
  | { op: 'refs'; query: RefsQuery }
  | { op: 'trace'; query: TraceQuery }
  | { op: 'list'; query: ListQuery }
  | { op: 'edit'; query: EditQuery };

/** One result, tagged with its `op`, in request order. The error arm (no `result`) marks
 *  a request that failed without sinking the rest of the batch. */
export type RequestResult =
  | { op: 'search'; result: Result<SearchHit[]> }
  | { op: 'resolve'; result: Result<ResolveResult> }
  | { op: 'refs'; result: Result<RefsResult> }
  | { op: 'trace'; result: Result<Fact<TraceStep[]>> }
  | { op: 'list'; result: Result<ListEntry[]> }
  | { op: 'edit'; result: Result<EditPreview> }
  | { op: Request['op']; error: string };

/** Results come back in request order. The batch-level `Result` carries the single
 *  `indexVersion` every read saw; each per-request `Result` still carries its own
 *  `handle` rebind and truncation. */
export type Batch = (requests: Request[]) => Promise<Result<RequestResult[]>>;

/** The full primitive surface, as wired into the daemon and exposed over MCP. The six
 *  verbs plus `batch`, the meta-verb that runs many of them in one round-trip. */
export interface Primitives {
  search: Search;
  resolve: Resolve;
  refs: Refs;
  trace: Trace;
  list: List;
  edit: Edit;
  batch: Batch;
}
