// `discrimination_sites` — the type-aware read op (§5-L3): given a union TYPE T, the `switch`
// statements and `if/else-if` chains that DISCRIMINATE on T — including scrutinees reached via
// property access (`switch (spec.type.kind)` where `spec.type: T`), which `find_usages` on T's NAME
// structurally misses. The "what must I update to stay exhaustive when I widen T?" query. A thin
// pass-through: the identity-gated scan + covers/missing diff live in the ts plugin (§5-L2).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result, Truncation } from '../core/result.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type {
  TsPluginApi,
  DiscriminationSite,
  DiscriminationTargetView,
} from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape, tsTargetIntake } from './ts-target.ts';

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    /** Hard cap on switch/if-head statements examined. Default 2000. */
    limit: z.number().int().positive().max(50_000).optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

type DiscriminationData = {
  target: DiscriminationTargetView;
  sites: DiscriminationSite[];
  scanned: { statements: number; files: number };
  truncated?: { examined: number; candidates: number };
  notes?: string[];
};

const discriminationSitesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'kind', type: 'text' },
    { name: 'scrutinee', type: 'text' },
    { name: 'discriminant', type: 'text' },
    { name: 'confidence', type: 'text' },
    { name: 'covers', type: 'text' },
    { name: 'missing', type: 'text' },
    { name: 'has_default', type: 'int' },
    { name: 'encloser', type: 'text' },
    { name: 'encloser_id', type: 'text' },
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const sites = (data as { sites?: DiscriminationSite[] }).sites ?? [];
    return sites.map((s): readonly Cell[] => [
      s.span.file,
      s.span.line,
      s.span.col,
      s.kind,
      s.scrutinee,
      s.discriminant,
      s.confidence,
      s.covers.join(' '),
      s.missing.join(' '),
      s.hasDefault ? 1 : 0,
      s.encloser.name,
      s.encloser.id,
      s.note ?? null,
    ]);
  },
  notes(data) {
    const out: string[] = [];
    const target = (data as { target?: DiscriminationTargetView }).target;
    if (target !== undefined) {
      const domains = target.discriminants
        .map((d) => `${d.name}:{${d.domain.join(',')}}`)
        .join(' ');
      out.push(
        `target: ${target.kind} ${target.name} @ ${target.span.file}:${target.span.line}${domains !== '' ? ` — discriminants ${domains}` : ''}`,
      );
    }
    const t = (data as { truncated?: { examined: number; candidates: number } }).truncated;
    if (t !== undefined) {
      out.push(
        `examined ${t.examined} of ${t.candidates} switch/if statements (cap hit) — narrow with pathInclude or raise limit to scan the rest.`,
      );
    }
    for (const n of (data as { notes?: string[] }).notes ?? []) out.push(n);
    return out;
  },
};

export const discriminationSitesOp = defineOp({
  name: 'discrimination_sites',
  summary:
    'switch statements + if/else-if chains that DISCRIMINATE on a union TYPE T (incl. scrutinees reached via property access like switch(x.kind) where x:T) — the type-aware "what must I update to stay exhaustive when I widen T?", which find_usages on T\'s name structurally misses',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} (the union TYPE) — plus { pathInclude?: string[], pathExclude?: string[], limit?: number }`,
  intake: tsTargetIntake,
  example: { args: { name: 'FieldType' } },
  notes: [
    'the exhaustiveness complement to find_usages: find_usages on a union NAME finds annotation sites but structurally MISSES `switch (spec.type.kind)` where spec.type: T (the identifier T never appears at the switch) and if/else-if chains — this op resolves the scrutinee TYPE, so it finds them.',
    "IDENTITY-gated (never structural): the scrutinee object's type must BE T (a union is assignable to `{ kind: string }`, so a structural relation would flag every `.kind` switch on every kind-union — excluded). The accessed property must be a DISCRIMINANT of T (a literal/unit field in every constituent), so `switch (f.value)` on a non-discriminant field is NOT matched.",
    "covers/missing: each site reports the discriminant literals its cases/branches cover, and `missing` = T's discriminant domain − covers (the exhaustiveness gap you must handle when widening T), plus a `hasDefault` flag. No hard `exhaustive: yes/no` is claimed — a `default`/`else` is reported, you judge.",
    'confidence: certain = a `switch` with an identity-T scrutinee and all cases read as literals · partial = an if/else-if chain (=== heuristic), an element-access `obj["k"]` scrutinee, or a case/branch value that could not be read as a literal. A partial site is honest uncertainty.',
    'v1 scope (honest under-coverage, stated): if-chains match only `X.disc === literal` branches chained via `else if` — a `!==`/`in`-narrowing/type-guard/negated-early-return/compound `&&` branch is not counted; a computed `obj[expr]` scrutinee is not read. The identity gate drops any scrutinee whose type is not EXACTLY T: a structural supertype/subtype, an INTERSECTION `T & X` (incl. the distributed union an `in`-narrowing yields), and a mapped-type wrapper `Readonly<T>` are all MISSED — recovering them needs structural matching, which would flood every kind-union, so it is intentionally not done. Primary program only (a sibling-only switch is not scanned).',
    'bounded: the switch/if statements examined are hard-capped (default 2000, raise with limit) and the cap is reported as truncation; scope with pathInclude/pathExclude. Each enclosing declaration is a chainable SymbolId (→ find_usages / source / rename_symbol).',
  ],
  table: discriminationSitesTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const outcome = ts.discriminationSites(args, {
        ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
        ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      if ('unresolved' in outcome) {
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      const { view, rebind } = outcome;
      const data: DiscriminationData = {
        target: tag('discrimination-target', view.target),
        sites: view.sites.map((s) => tag('discrimination-site', s)),
        scanned: { statements: view.scannedStatements, files: view.scannedFiles },
        ...(view.truncated !== undefined ? { truncated: view.truncated } : {}),
        ...(view.notes !== undefined ? { notes: view.notes } : {}),
      };
      const truncated: Truncation | undefined =
        view.truncated !== undefined
          ? {
              shown: view.truncated.examined,
              total: view.truncated.candidates,
              hint: 'narrow with pathInclude / pathExclude, or raise limit, to scan the rest',
            }
          : undefined;
      const extras = {
        ...(rebind !== undefined ? { handle: rebind } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      };
      return ok(data as JsonValue, Object.keys(extras).length > 0 ? extras : undefined);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
