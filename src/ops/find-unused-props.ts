// `find_unused_props` — for a React component, the DECLARED props that NO JSX call-site passes
// (dead props), the prop-level analogue of `find_unused_exports` (§5-L3). A thin pass-through to
// the react plugin's `unusedProps` read-model (the diff + honesty demotion live in the plugin,
// §5-L2). HONESTY: a prop is `certain`-unused only when every `<C/>` site is cleanly readable; a
// spread (`{...x}`), a factory `createElement` / value reference (`memo(C)`), or a capped site set
// demotes the WHOLE set to `partial` — never a false `certain` (a live prop called dead).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { ReactPluginApi, UnusedProp } from '../plugins/react/plugin.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';

const findUnusedPropsTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'name', type: 'text' },
    { name: 'optional', type: 'int' },
    { name: 'inherited', type: 'int' },
    { name: 'type', type: 'text' },
    { name: 'confidence', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
  ],
  rows(data) {
    const unused = (data as { unused?: UnusedProp[] }).unused ?? [];
    return unused.map((u): readonly Cell[] => [
      u.name,
      u.optional ? 1 : 0,
      u.inherited === true ? 1 : 0,
      u.type,
      u.confidence,
      u.span?.file ?? null,
      u.span?.line ?? null,
      u.span?.col ?? null,
    ]);
  },
  notes(data) {
    return (data as { notes?: string[] }).notes ?? [];
  },
};

export const findUnusedPropsOp = defineOp({
  name: 'find_unused_props',
  summary:
    'Declared props of a React component that no JSX call-site passes (dead props); spread/opaque-ref demotes to partial',
  mutating: false,
  requires: ['react'],
  argsSchema: z.strictObject({
    component: z.string(),
    file: z.string().optional(),
    /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
    force: z.boolean().optional(),
  }),
  argsHint: '{ component: string, file?: string, force?: boolean }',
  example: { args: { component: 'Button' } },
  intake: { aliases: { name: 'component', symbol: 'component' } },
  notes: [
    "on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (reading passed props fans `<C/>` references across every program and would OOM, killing the daemon) and redirects to `daemon.isolation:'process'`; pass `force:true` to warm anyway. No refusal in process-mode.",
    'declared props come from the checker on the component’s first parameter type — `extends`/intersection (`A & B`) props are FLATTENED in (the checker’s own merge), so an inherited base prop is counted, not missed.',
    'passed props are read semantically from each `<C .../>` site via findReferences — an aliased `import { C as D }` … `<D foo/>` is SEEN (grep would miss it), so a prop passed only through an alias is never falsely reported dead.',
    'HONESTY: a prop is reported `certain`-unused only when every reference is a cleanly-readable `<C/>` site. A `{...spread}`, a factory call (`React.createElement(C, props)`), or a value reference (`memo(C)`, `const D = C`) makes the passed set unreadable → EVERY candidate demotes to `partial` (could-not-prove-dead), with the reason in notes. Over-demotion is honest; a false `certain` is not.',
    'component is resolved by react convention (a PascalCase function returning JSX). 0 matches or an ambiguous name → reported honestly in `note`, never an empty success; pass `file` to disambiguate.',
    'a prop passed at ANY readable site is "used" and not reported — this finds never-passed props, not props passed only sometimes.',
    'usage is discovered across the LOADED programs (primary + sibling tsconfigs, so a `<C/>` in `test/**` counts) — but a component rendered ONLY from an undiscovered nested-package config (neither adjacent to the main tsconfig nor `references`d) is not seen, so a prop passed only there would read `certain`-unused. The same cross-program floor `find_unused_exports` carries; verify before deleting a prop in a multi-package repo.',
  ],
  table: findUnusedPropsTable,
  async run(ctx, args) {
    const react = ctx.plugins.get<ReactPluginApi>('react');
    // Pre-warm guard (t-411303): reading passed props fans `<C/>` references across every program
    // (the react plugin rides find_usages) — on an oversized in-process repo that OOMs and kills the
    // daemon (§1). Refuse with a process-mode redirect BEFORE any resolve/warm (the `ts` plugin is a
    // dep of `react`, so its estimate seam is available). `force` bypasses.
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const refusal = semanticFanoutRefusal(ctx, ts, args.force);
    if (refusal !== undefined) return fail(refusal);
    try {
      const result = react.unusedProps(args.component, args.file);
      if (!result.ok) {
        // Honest non-result (not found / ambiguous / unresolvable) — never a fabricated success.
        // `notes` (plural) so it renders through the same table-notes channel as the demote reasons.
        return ok({ component: args.component, found: 0, notes: [result.message] });
      }
      const view = result.view;
      const notes: string[] = [...view.demoteReasons];
      if (view.noParam) notes.push('component takes no first parameter — no props to declare');
      if (view.truncatedMembers !== undefined) {
        notes.push(
          `declared-member set capped at ${view.truncatedMembers.shown}/${view.truncatedMembers.total}`,
        );
      }
      // Verdict-before-bulk (§12): the small counts/verdict render FIRST, the (re-fetchable)
      // `unused` list LAST, so the char-cap can only ever truncate the list, never the verdict.
      return ok({
        component: view.component.name,
        found: view.unused.length,
        declared: view.declaredCount,
        passed: view.passedCount,
        callSites: view.callSiteCount,
        demoted: view.demoted,
        ...(notes.length > 0 ? { notes } : {}),
        unused: view.unused.map((u) => tag('unused-prop', u)),
      });
    } catch (thrown) {
      return failFromThrown('react', thrown);
    }
  },
});
