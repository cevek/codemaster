// Topological sort + cycle detection over declared dependency edges — the algorithm
// the `PluginRegistry` runs at engine init (ARCHITECTURE.md §5-L2). Pure: nodes in,
// order or a precise refusal out. Refusal carries the actual cycle / missing edge so
// the error is pointed, not "something is wrong with your plugins".

export interface DependencyNode {
  id: string;
  deps: readonly string[];
}

export type TopoResult =
  | { ok: true; order: readonly string[] }
  | { ok: false; reason: 'cycle'; cycle: readonly string[] }
  | { ok: false; reason: 'missing-dep'; id: string; missing: string }
  | { ok: false; reason: 'duplicate-id'; id: string };

export function topoSort(nodes: readonly DependencyNode[]): TopoResult {
  const byId = new Map<string, DependencyNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) return { ok: false, reason: 'duplicate-id', id: node.id };
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!byId.has(dep)) return { ok: false, reason: 'missing-dep', id: node.id, missing: dep };
    }
  }

  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | undefined => {
    const seen = state.get(id);
    if (seen === 'done') return undefined;
    if (seen === 'visiting') {
      // Slice the current DFS stack from the first occurrence — that is the cycle.
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    const node = byId.get(id);
    for (const dep of node?.deps ?? []) {
      const cycle = visit(dep);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    order.push(id);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle !== undefined) return { ok: false, reason: 'cycle', cycle };
  }
  return { ok: true, order };
}
