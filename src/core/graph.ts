import type { Loc, Provenance } from './span.js';
import type { SymbolKind } from './ids.js';
import type { NodeId, RepoId, IndexVersion, FileVersion, RepoRelPath } from './brands.js';
import type { JsonValue } from './json.js';

// The in-memory knowledge graph: the runtime source of truth for *structure*.
//
// Built from the TypeScript syntactic AST (the cheap tier) plus asset indexers
// (scss / i18n / schema) and framework adapters. The LanguageService is NOT stored
// here — it is the live semantic oracle, queried on demand. The graph never holds a
// type fact that could go stale. (ARCHITECTURE.md §5 L2.)
//
// The graph is **immutable**: indexers and `edit` build a new version and the daemon
// swaps the pointer atomically, so a reader pins the current `Graph` and reads it to
// completion tear-free, lock-free (the concurrency model, ARCHITECTURE.md §8). All
// fields are `readonly` to keep that load-bearing, not decorative.

/** Node-kind discriminants. All literal (incl. the generic `adapter` bucket) so the
 *  `GraphNode` union narrows cleanly. Core enumerates **no** framework-specific kinds —
 *  adapter-contributed nodes use `'adapter'` + an open `adapterKind`, so adding a
 *  framework never edits core. */
export type NodeKind =
  | 'file'
  | 'symbol'
  | 'jsxElement'
  | 'import'
  | 'cssClass'
  | 'i18nKey'
  | 'adapter';

/** First-party edge kinds; adapters add their own (`invalidates`, `submitsTo`,
 *  `mountedIn`, …) through the open tail. (Edges are a single shape, not a discriminated
 *  union, so the open tail is safe here.) */
export type EdgeKind =
  | 'imports'
  | 'reexports'
  | 'renders' // jsxElement → component symbol
  | 'usesClass' // file/jsxElement → cssClass
  | 'usesKey' // callsite → i18nKey
  | 'declaredIn' // symbol → file
  | (string & {}); // adapter-contributed: invalidates, submitsTo, mountedIn, …

// ── Nodes ───────────────────────────────────────────────────────────────────
// A discriminated union on `kind`: first-party kinds carry typed structural fields;
// adapter-contributed nodes carry a JSON `attrs` bag — the one place an open shape is
// unavoidable (third-party adapters define their own). No `unknown` anywhere.

/** Fields common to every node; the per-kind interfaces below extend it. */
export interface GraphNodeBase {
  id: NodeId;
  name: string;
  loc: Loc;
}
export interface FileNode extends GraphNodeBase {
  kind: 'file';
}
export interface SymbolNode extends GraphNodeBase {
  kind: 'symbol';
  symbolKind: SymbolKind;
}
export interface JsxElementNode extends GraphNodeBase {
  kind: 'jsxElement';
  tag: string;
  /** Literal attribute values. `value` is omitted when the attribute is dynamic (an
   *  expression) — the structural tier records what it sees and never guesses the rest. */
  props: ReadonlyArray<{ name: string; value?: string }>;
}
export interface ImportNode extends GraphNodeBase {
  kind: 'import';
  /** The module specifier as written. */
  specifier: string;
  typeOnly: boolean;
}
export interface CssClassNode extends GraphNodeBase {
  kind: 'cssClass';
  /** The stylesheet the class is declared in. */
  module: RepoRelPath;
}
export interface I18nKeyNode extends GraphNodeBase {
  kind: 'i18nKey';
  /** The full dotted key. */
  key: string;
}
/** A node contributed by a framework adapter (route, store, mutation, …). `kind` is the
 *  generic `'adapter'`; `adapterKind` names the framework concept; framework-specific
 *  fields live in the JSON-typed `attrs` — the single, contained open shape. */
export interface AdapterNode extends GraphNodeBase {
  kind: 'adapter';
  adapterKind: string;
  attrs?: Record<string, JsonValue>;
}

export type GraphNode =
  | FileNode
  | SymbolNode
  | JsxElementNode
  | ImportNode
  | CssClassNode
  | I18nKeyNode
  | AdapterNode;

// ── Edges ───────────────────────────────────────────────────────────────────

export interface GraphEdge {
  kind: EdgeKind;
  from: NodeId;
  to: NodeId;
  loc?: Loc;
  /** How this edge was derived. An adapter-inferred edge (e.g. `invalidates`) is tagged
   *  `heuristic` with its source, so the agent sees it isn't a proven structural fact. */
  provenance?: Provenance;
  /** Edge-specific payload, JSON-typed (e.g. an `invalidates` edge's query keys). The open
   *  bag is confined here and to `AdapterNode` — never `unknown`. */
  data?: Record<string, JsonValue>;
}

/** A per-repo, immutable graph version. */
export interface Graph {
  repoId: RepoId;
  /** Monotonic version of the whole graph; bumped on every atomic swap. A
   *  `FreshnessNote` reports this value. */
  indexVersion: IndexVersion;
  /** Per-file version stamps. A `SymbolId` binds to *its file's* version, so a change to
   *  another file never stales the handle (ARCHITECTURE.md §6). */
  fileVersions: ReadonlyMap<RepoRelPath, FileVersion>;
  nodes: ReadonlyMap<NodeId, GraphNode>;
  edges: readonly GraphEdge[];
}
