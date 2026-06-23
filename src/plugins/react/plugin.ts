// The `react` framework plugin (§5-L2), `deps: ['ts']`. It owns no parser and no file state
// of its own (§4): every fact is DERIVED on demand from the `ts` plugin's framework-neutral
// seams (`functionDeclarations` + `findUsages` + the `jsxCallSites` / `firstParamTypeMembers`
// scans the unused-props read-model consumes), with the React conventions applied here
// (detect.ts / dialogs.ts / conventions.ts / unused-props.ts). It exposes three `list` registries
// (routed by the generic `list` op, core/list.ts) and the `unusedProps` read-model behind the
// `find_unused_props` op (its only react-specific op surface).
//
// Autodetected (loaded iff `react` is a `package.json` dependency, or `config.plugins` names
// it — the composition root's framework gate, bin.ts). Because it holds no state, its
// `freshness` is a constant and `reindex` is a no-op: the staleness that matters is the `ts`
// plugin's (its fingerprint rides in the aggregate FreshnessNote), and `list` reads `ts` live.

import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { ListView } from '../../core/list.ts';
import type { TsPluginApi } from '../ts/plugin.ts';
import type { TsTargetInput } from '../ts/plugin.ts';
import { detectComponents, detectHooks, COMPONENTS_NOTE } from './detect.ts';
import { detectDialogs } from './dialogs.ts';
import { pickComponent, computeUnusedProps, type UnusedPropsResult } from './unused-props.ts';

// Public surface for the unused-props read-model — ops depend on these, never on the internal
// `unused-props.ts` module (§5-L3).
export type { UnusedProp, UnusedPropsView, UnusedPropsResult } from './unused-props.ts';

const REGISTRIES = ['components', 'hooks', 'dialogs'] as const;

export interface ReactPluginApi extends Plugin {
  /** Declared-but-never-passed props of the component named `component` (optionally scoped to
   *  `file`). The read-model over the `ts` plugin's `firstParamTypeMembers` + `jsxCallSites`
   *  seams; verdicts demote to `partial` when a spread / opaque reference / capped site set makes
   *  the passed props unreadable. An honest message when the component isn't found / is ambiguous. */
  unusedProps(component: string, file?: string): UnusedPropsResult;
}

export function createReactPlugin(): ReactPluginApi {
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

    unusedProps(component: string, file?: string): UnusedPropsResult {
      const ts = tsApi();
      const picked = pickComponent(ts.functionDeclarations().decls, component, file);
      if (!picked.ok) return picked;
      const { span } = picked.decl;
      // Address the ts seams by the component's name-token position (precise, disambiguated by
      // pickComponent) — never a fuzzy name re-search.
      const target: TsTargetInput = { file: span.file, line: span.line, col: span.col };

      const membersOut = ts.firstParamTypeMembers(target);
      if (typeof membersOut === 'string') return { ok: false, message: membersOut };
      if (!('view' in membersOut)) return { ok: false, message: membersOut.unresolved };

      const jsxOut = ts.jsxCallSites(target);
      if (typeof jsxOut === 'string') return { ok: false, message: jsxOut };
      if (!('view' in jsxOut)) return { ok: false, message: jsxOut.unresolved };

      return { ok: true, view: computeUnusedProps(picked.decl, membersOut.view, jsxOut.view) };
    },

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
