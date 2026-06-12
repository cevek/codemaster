// Build a `PluginRegistry` (core/plugin.ts) from a plugin list: validate the DAG
// (refuse cycles / missing deps / duplicates — at init, not at op time: an op-time
// crash would be lying about plugin capability, §16 invariant 7), topologically sort,
// and expose typed lookup.
//
// Construction is pure — no `init()` calls happen here; the engine drives plugin
// lifecycle in the returned `order` (and disposes in reverse).

import type { Plugin, PluginRegistry } from '../../core/plugin.ts';
import { topoSort } from './toposort.ts';

export type CreateRegistryResult =
  | { ok: true; registry: PluginRegistry; order: readonly Plugin[] }
  | { ok: false; message: string };

export function createPluginRegistry(plugins: readonly Plugin[]): CreateRegistryResult {
  const sorted = topoSort(plugins.map((p) => ({ id: p.id, deps: p.deps })));
  if (!sorted.ok) {
    switch (sorted.reason) {
      case 'cycle':
        return {
          ok: false,
          message: `plugin dependency cycle: ${sorted.cycle.join(' -> ')} — plugins must form a strict DAG (ARCHITECTURE.md §5-L2)`,
        };
      case 'missing-dep':
        return {
          ok: false,
          message: `plugin '${sorted.id}' declares dep '${sorted.missing}' which is not registered`,
        };
      case 'duplicate-id':
        return { ok: false, message: `duplicate plugin id '${sorted.id}'` };
    }
  }

  const byId = new Map(plugins.map((p) => [p.id, p]));
  const ids = sorted.order;
  const registry: PluginRegistry = {
    get<T extends Plugin>(id: string): T {
      const plugin = byId.get(id);
      if (plugin === undefined) {
        throw new Error(`plugin '${id}' is not registered (known: ${ids.join(', ') || 'none'})`);
      }
      return plugin as T;
    },
    has: (id) => byId.has(id),
    ids,
  };

  const order = ids.flatMap((id) => {
    const plugin = byId.get(id);
    return plugin === undefined ? [] : [plugin];
  });
  return { ok: true, registry, order };
}
