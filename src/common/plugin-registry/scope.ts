// Dep-scoped view of a `PluginRegistry`. A plugin's `init(deps)` receives this view,
// restricted to its *declared* `deps` — so "a `get(id)` call to an undeclared id is a
// programming error" (ARCHITECTURE.md §5-L2) is enforced at runtime, not just hoped
// for. Ops (which sit above the DAG) get the full registry.

import type { Plugin, PluginRegistry } from '../../core/plugin.ts';

export function scopeRegistry(
  base: PluginRegistry,
  consumerId: string,
  allowed: readonly string[],
): PluginRegistry {
  const allowedSet = new Set(allowed);
  return {
    get<T extends Plugin>(id: string): T {
      if (!allowedSet.has(id)) {
        throw new Error(
          `plugin '${consumerId}' asked for '${id}' without declaring it in deps — ` +
            `declared: [${allowed.join(', ')}] (ARCHITECTURE.md §5-L2)`,
        );
      }
      return base.get<T>(id);
    },
    has: (id) => allowedSet.has(id) && base.has(id),
    ids: allowed.filter((id) => base.has(id)),
  };
}
