import type { Graph, GraphNode, GraphEdge } from './graph.js';
import type { RepoRelPath } from './brands.js';

// Framework-adapter seam (ARCHITECTURE.md §5 L1.5).
//
// An adapter is a plugin that enriches the graph during indexing with
// framework-specific nodes and edges — router routes, react-query `invalidates`
// edges, zustand stores — and declares both the `list` registries it owns and the kinds
// it contributes (nodes via `adapterKind` under the generic `'adapter'` node kind; edges
// in `EdgeKind`'s open tail), so core's unions stay framework-free. Adapters
// **self-register at the composition root** (the daemon). The `list` and `trace`
// primitives read only the graph and the registry below; they never import a concrete
// adapter, so adding a framework changes neither the core nor the primitives — the
// dependency points inward.

export interface Adapter {
  readonly name: string;
  /** `list` registries this adapter owns, e.g. `['routes', 'mutations']`. */
  readonly registries: readonly string[];
  /** The `adapterKind`s (nodes) and edge kinds this adapter contributes, e.g.
   *  `{ nodes: ['route'], edges: ['mountedIn'] }`. */
  readonly contributes?: { nodes?: readonly string[]; edges?: readonly string[] };
  /** Whether this adapter applies to the repo (autodetect from the graph). */
  detect(graph: Graph): boolean;
  /** Framework nodes/edges to fold into the graph for one file, during indexing. */
  index(file: RepoRelPath, graph: Graph): { nodes?: GraphNode[]; edges?: GraphEdge[] };
}

/** What the `list` / `trace` primitives consume: the active adapters and the registry
 *  names they expose. Assembled at the composition root and injected — primitives
 *  depend on this interface, never on a concrete adapter module. */
export interface AdapterRegistry {
  active(): readonly Adapter[];
  /** All `list` registry names contributed by active adapters. */
  registries(): readonly string[];
}
