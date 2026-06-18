// The `react-query` framework plugin (§5-L2, deps: ['ts']). Owns mutation / query / invalidation
// knowledge for TanStack Query v5. It introduces NO parser (§4): every fact is derived from the ts
// plugin's generic `callArgShapes` seam — react-query owns only the queryKey / invalidation POLICY
// (query-key.ts, registries.ts, invalidations.ts). Detection is import-anchored to
// '@tanstack/react-query' (by-identity), so a same-named `useQuery` from another module is not
// mistaken for it; `qc.invalidateQueries()` matches via the `useQueryClient` hook binding.
//
// Enabled iff the framework plugin is selected (config.plugins / autodetect) — the gate lives in
// the composition root (`pluginsFor`), never in `opsFor`; the op registers unconditionally with
// `requires: ['react-query']` (the i18n/schema precedent).

import type { FreshnessFingerprint, Plugin, PluginRegistry } from '../../core/plugin.ts';
import type { CallMatchSpec, TsPluginApi } from '../ts/plugin.ts';
import type { ListView } from '../../core/list.ts';
import { buildRegistries, type RqState } from './registries.ts';
import { computeInvalidationsFor } from './invalidations.ts';
import { buildListView, REGISTRIES } from './list.ts';
import type { InvalidationsForView, MutationsView, QueriesView } from './views.ts';

/** The seam spec: the v5 hooks + QueryClient methods, anchored to the module by identity. The
 *  invalidate methods are simple leaves matched on a `const qc = useQueryClient()` member base
 *  (`hook`), so `qc.invalidateQueries()` resolves without naming a static namespace. */
const SPEC: CallMatchSpec = {
  functions: [
    'useQuery',
    'useInfiniteQuery',
    'useMutation',
    'useQueryClient',
    'invalidateQueries',
    'refetchQueries',
    'removeQueries',
  ],
  module: '@tanstack/react-query',
  hook: 'useQueryClient',
};

export interface ReactQueryPluginApi extends Plugin {
  mutations(): MutationsView;
  queries(): QueriesView;
  invalidationsFor(ref: string): InvalidationsForView;
}

export function createReactQueryPlugin(): ReactQueryPluginApi {
  let registry: PluginRegistry | undefined;
  let memo: { key: string; state: RqState } | undefined;

  const ts = (): TsPluginApi => {
    if (registry === undefined) throw new Error('react-query plugin not initialized');
    return registry.get<TsPluginApi>('ts');
  };

  // Memoized on the ts plugin's freshness: a batch of react-query ops scans once, and a reindex
  // (which bumps ts freshness) drops the memo so the next read recomputes against current state.
  const state = (): RqState => {
    const tsApi = ts();
    const key = tsApi.freshness();
    if (memo === undefined || memo.key !== key) {
      memo = { key, state: buildRegistries(tsApi.callArgShapes(SPEC)) };
    }
    return memo.state;
  };

  return {
    id: 'react-query',
    version: '0.1.0',
    deps: ['ts'],
    init(deps) {
      registry = deps;
      return Promise.resolve();
    },
    dispose() {
      memo = undefined;
      return Promise.resolve();
    },
    // Derived plugin — no own file state. Freshness mirrors ts's, so the read-time guard treats
    // react-query as current exactly when ts is; `callArgShapes` (memoized in ts on the same
    // fingerprint) is read fresh after the guard reindexes ts on drift (§3.5/§8).
    freshness(): FreshnessFingerprint {
      return registry === undefined ? 'cold' : ts().freshness();
    },
    reindex() {
      return Promise.resolve();
    },
    pending: () => [],
    mutations() {
      const s = state();
      return { mutations: s.mutations, moduleResolved: s.moduleResolved };
    },
    queries() {
      const s = state();
      return { queries: s.queries, moduleResolved: s.moduleResolved };
    },
    invalidationsFor(ref) {
      return computeInvalidationsFor(state(), ref);
    },
    // The generic `list` op (§11) routes to these — react-query owns the mutations / queries /
    // queryKeys registries. `list` is only called for a registry this plugin claimed.
    listRegistries() {
      return REGISTRIES;
    },
    list(registry): ListView {
      return buildListView(state(), registry) ?? { registry, entries: [] };
    },
  };
}
