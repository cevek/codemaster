// The `react` framework plugin (§5-L2), `deps: ['ts']`. It owns no parser and no file state
// of its own (§4): every fact is DERIVED on demand from the `ts` plugin's framework-neutral
// `functionDeclarations()` scan + `findUsages`, with the React conventions applied here
// (detect.ts / dialogs.ts / conventions.ts). It exposes three registries through the optional
// `listRegistries` / `list` members the generic `list` op routes to (core/list.ts) — no
// react-specific op and no react-specific MCP surface.
//
// Autodetected (loaded iff `react` is a `package.json` dependency, or `config.plugins` names
// it — the composition root's framework gate, bin.ts). Because it holds no state, its
// `freshness` is a constant and `reindex` is a no-op: the staleness that matters is the `ts`
// plugin's (its fingerprint rides in the aggregate FreshnessNote), and `list` reads `ts` live.

import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { ListView } from '../../core/list.ts';
import type { TsPluginApi } from '../ts/plugin.ts';
import { detectComponents, detectHooks, COMPONENTS_NOTE } from './detect.ts';
import { detectDialogs } from './dialogs.ts';

const REGISTRIES = ['components', 'hooks', 'dialogs'] as const;

export function createReactPlugin(): Plugin {
  let registry: PluginRegistry | undefined;
  const tsApi = (): TsPluginApi => {
    if (registry === undefined) throw new Error('react plugin not initialized');
    return registry.get<TsPluginApi>('ts');
  };

  return {
    id: 'react',
    version: '0.1.0',
    deps: ['ts'],

    init(deps) {
      registry = deps;
      return Promise.resolve();
    },
    dispose() {
      registry = undefined;
      return Promise.resolve();
    },
    // Derived plugin: no own file state, so a constant fingerprint. The `ts` plugin's
    // fingerprint (which DOES move with the tree) is what the read-time guard reindexes on.
    freshness(): FreshnessFingerprint {
      return 'react@0.1.0';
    },
    reindex() {
      return Promise.resolve();
    },
    pending: () => [],

    listRegistries: () => REGISTRIES,
    list(registry: string): ListView {
      const ts = tsApi();
      const decls = ts.functionDeclarations().decls;
      switch (registry) {
        case 'components':
          return { registry, entries: detectComponents(decls), note: COMPONENTS_NOTE };
        case 'hooks':
          return { registry, entries: detectHooks(decls) };
        case 'dialogs':
          return { registry, ...detectDialogs(decls, ts) };
        default:
          return { registry, entries: [] };
      }
    },
  };
}
