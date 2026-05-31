import type { NodeId, IndexVersion, RepoRelPath } from '../core/brands.js';
import type { GraphNode, GraphEdge, NodeKind } from '../core/graph.js';

// The graph-storage seam (ARCHITECTURE.md §5 L2). Its one job: store, update, and serve
// the graph. *Where* it keeps the graph — in-memory maps, SQLite, off-heap — is its own
// business, hidden behind this interface, so the backend can change (memory → SQLite for
// heap/GC health on a huge workspace) without touching a single consumer. Like
// tree-sitter, consumers get query results and readonly views — never the raw internal
// representation.

export interface GraphDelta {
  /** Files reindexed in this delta — their previous nodes/edges are replaced. */
  reindexed: readonly RepoRelPath[];
  /** Files removed — their nodes/edges are dropped. */
  removed: readonly RepoRelPath[];
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

export interface GraphStore {
  /** Current immutable version stamp (bumped on each `commit`). */
  version(): IndexVersion;
  get(id: NodeId): GraphNode | undefined;
  nodesByKind(kind: NodeKind): readonly GraphNode[];
  edgesFrom(id: NodeId): readonly GraphEdge[];
  edgesTo(id: NodeId): readonly GraphEdge[];
  /** Single-writer (§8), **synchronous** — build + pointer-swap with no `await` between, so
   *  writes never interleave: build the next immutable version from a per-file delta and swap
   *  it in atomically; returns the new version. The in-memory backend builds it with
   *  **copy-on-write per shard** (share unchanged shards, replace only the changed file's —
   *  not a full-map copy), so a swap stays O(changed) in heap, not just on disk (§19). The
   *  read methods grow as the primitives need them — but always return results, never the
   *  backend's internals. */
  commit(delta: GraphDelta): IndexVersion;
}
