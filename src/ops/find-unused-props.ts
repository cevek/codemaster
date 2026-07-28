// `find_unused_props` — for a React component, the DECLARED props that NO JSX call-site passes
// (dead props), the prop-level analogue of `find_unused_exports` (§5-L3). A thin pass-through to
// the react plugin's `unusedProps` read-model (the diff, the honesty demotion and the view
// narrowing live in the plugin, §5-L2). HONESTY: a prop is `certain`-unused only when every `<C/>`
// site is cleanly readable; a spread (`{...x}`), a factory `createElement` / value reference
// (`memo(C)`), or a capped site set demotes the WHOLE set to `partial` — never a false `certain`
// (a live prop called dead). The default view answers about the props the REPO declares (a wrapper
// over `React.ComponentProps<'button'>` declares ~290 more through a dependency's type, and can act
// on none of them); what that omits is COUNTED (`hiddenExternal`) and carries its own escape hatch
// — the narrowing is never silent (§3.4).

import { z } from 'zod';
import { forceFlagGuardNotOverridable } from './force-flag.ts';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
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
    { name: 'external', type: 'int' },
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
      u.external === true ? 1 : 0,
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

/** Requested names named in the `undetermined` NOTE before `+N more` (§3.4). The `undetermined`
 *  FIELD itself is never capped — it is a per-name verdict, not bulk: dropping an entry would lose
 *  an answer the caller asked for. Only the prose repeat of it is bounded. */
const UNDETERMINED_PREVIEW = 8;

/** `prop` accepts one name or a list — one shape for the read-model. */
const normalizeNames = (prop: string | string[]): readonly string[] =>
  typeof prop === 'string' ? [prop] : prop;

export const findUnusedPropsOp = defineOp({
  name: 'find_unused_props',
  summary:
    'Declared props of a React component that no JSX call-site passes (dead props) — the REPO-declared ones by default (`includeExternal` also lists the props declared outside the repo, typically a dependency’s DOM/aria surface; `prop:` asks about named props); spread/opaque-ref demotes to partial',
  mutating: false,
  requires: ['react'],
  argsSchema: z.strictObject({
    component: z.string(),
    file: z.string().optional(),
    /** Answer for these declared props only (one name or a list) — overrides the default
     *  repo-declared narrowing, since the caller named the prop. */
    prop: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** List props declared OUTSIDE the repo's own source too (default: omitted + counted). */
    includeExternal: z.boolean().optional(),
    /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
    force: forceFlagGuardNotOverridable(),
  }),
  argsHint:
    '{ component: string, file?: string, prop?: string | string[], includeExternal?: boolean, force?: boolean }',
  example: { args: { component: 'Button', prop: 'variant' } },
  intake: {
    aliases: {
      name: 'component',
      symbol: 'component',
      props: 'prop',
      external: 'includeExternal',
    },
  },
  notes: [
    'on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (reading passed props fans `<C/>` references across every program and would OOM, killing the daemon) and says WHY it was not auto-escalated into a killable child (t-754922) plus the one remedy for that cause. `force:true` does NOT override it (forcing killed the daemon in production). No refusal in an escalated / configured process-mode child.',
    'declared props come from the checker on the component’s first parameter type — `extends`/intersection (`A & B`) props are FLATTENED in (the checker’s own merge), so a base-type prop is counted, not missed. It may still be HIDDEN from the default view when its declaration sits outside the repo (below).',
    "DEFAULT VIEW = props the REPO declares. A prop whose DECLARATION file sits under `node_modules` or outside the repo root is omitted and counted as `hiddenExternal` (+ a note) — a wrapper over `React.ComponentProps<'button'>` otherwise buries its one own prop under ~290 DOM/aria members nobody can delete. `includeExternal:true` lists them, each such row stamped `external` (absent, not `false`, on a repo-declared one) — a DIFFERENT claim from `inherited` (heritage), which an anonymous intersection carries for no member at all, so neither substitutes for the other. Under a CAPPED declared-member set (see the cap note) the cap is applied UPSTREAM of this filter, so a repo-declared prop past the cap is neither listed nor counted in `hiddenExternal`: `found` is a floor there, for a second and unrelated reason.",
    '`prop:` answers about named props only, and OVERRIDES the external narrowing (the caller named it). A `found:0` there is disambiguated into three states, never merged: `inUse` (declared and passed at ≥1 readable site — the answer to "does anything still pass X?"), `notDeclared` (not a member), `undetermined` (absent from a CAPPED member set — cannot claim it is not declared).',
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
    // daemon (§1). Refuse BEFORE any resolve/warm, naming why the repo was not auto-escalated (the `ts` plugin is a
    // dep of `react`, so its estimate seam is available). `force` does NOT override it (t-693742).
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const refusal = semanticFanoutRefusal(ctx, ts, args.force, args);
    if (refusal !== undefined) return fail(refusal);
    try {
      const prop = args.prop === undefined ? undefined : normalizeNames(args.prop);
      const result = react.unusedProps(args.component, args.file, {
        ...(prop !== undefined ? { prop } : {}),
        ...(args.includeExternal === true ? { includeExternal: true } : {}),
      });
      if (!result.ok) {
        // Honest non-result (not found / ambiguous / unresolvable) — never a fabricated success.
        // `notes` (plural) so it renders through the same table-notes channel as the demote reasons.
        return ok({ component: args.component, found: 0, notes: [result.message] });
      }
      const view = result.view;
      const capped = view.truncatedMembers;
      const notes: string[] = [...view.demoteReasons];
      if (view.noParam) notes.push('component takes no first parameter — no props to declare');
      // The declared-member cap is stated by the read-model itself (it also DEMOTES the verdict,
      // like a spread does) — not re-emitted here, so the two channels can never disagree.
      if (view.hiddenExternal !== undefined) {
        // The omission the default view performs — stated with its own remedy, never silent
        // (§3.4). Under a capped member set the count is a floor, and `includeExternal` recovers
        // only what THIS filter hid — never what the cap cut (nothing does). At ZERO (reachable
        // only under a bitten cap) the flag would list nothing, so it is not named: a remedy that
        // provably returns the same answer is the "already spent" advice, not a remedy.
        notes.push(
          view.hiddenExternal > 0
            ? `${capped !== undefined ? '≥' : ''}${view.hiddenExternal} unused prop(s) hidden by this view — declared outside the repo's own source (node_modules / outside the root); includeExternal:true lists them${capped !== undefined ? ' (it does NOT recover the capped members above)' : ''}`
            : `0 unused props hidden by this view (every member the cap left is repo-declared) — but members past the cap were never classified, so this zero is a floor and includeExternal:true would add nothing`,
        );
      }
      if (view.undetermined !== undefined) {
        notes.push(
          `${nameWithMore(view.undetermined, UNDETERMINED_PREVIEW)}: not in the declared-member set — but that set was capped, so this is NOT a claim that the prop is undeclared`,
        );
      }
      // Verdict-before-bulk (§12): the small counts/verdict render FIRST, the (re-fetchable)
      // `unused` list LAST, so the char-cap can only ever truncate the list, never the verdict.
      return ok({
        component: view.component.name,
        found: view.unused.length,
        declared: view.declaredCount,
        ...(view.hiddenExternal !== undefined ? { hiddenExternal: view.hiddenExternal } : {}),
        // A structured floor marker beside the number: `format:'json'` / sql consumers read the
        // count without the prose, and a floor read as exact is the §3.4 lie (cf. `Truncation.
        // totalIsLowerBound`).
        ...(view.hiddenExternal !== undefined && capped !== undefined
          ? { hiddenExternalIsLowerBound: true }
          : {}),
        ...(view.inUse !== undefined ? { inUse: view.inUse } : {}),
        ...(view.notDeclared !== undefined ? { notDeclared: view.notDeclared } : {}),
        ...(view.undetermined !== undefined ? { undetermined: view.undetermined } : {}),
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
