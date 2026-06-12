// `source` — the explore-style call: the bodies of N symbols in one round-trip (§3.2).
// The single biggest field gap ("80% of my Reads were 'show me the body'"). Composes
// `ts.findDefinition` per target (which carries the full declaration span via §3.1);
// unresolvable / ambiguous targets come back in an `unresolved` section, never silently
// dropped. Rendering (budget + elision) lives in format/render/render-source.ts.
//
// Routing: ts-only today. When other plugins grow a `sourceOf()`, dispatch by SymbolId
// prefix (§6) — do NOT build the generic dispatcher now.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { TsTargetInput } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget } from './ts-target.ts';

const targetSchema = z.strictObject(tsTargetShape).refine(requireTarget.predicate, {
  message: requireTarget.message,
});

const argsSchema = z.strictObject({
  targets: z
    .array(targetSchema)
    .min(1, { message: 'pass at least one target' })
    .max(20, { message: 'at most 20 targets per call — split into batches, or chain SymbolIds' }),
});

function describeTarget(t: TsTargetInput): string {
  if (t.symbol !== undefined) return t.symbol;
  if (t.name !== undefined) return t.name;
  if (t.file !== undefined) return `${t.file}:${t.line ?? '?'}:${t.col ?? '?'}`;
  return '<target>';
}

export const sourceOp = defineOp({
  name: 'source',
  summary: 'Source bodies of N symbols in one call (the explore-style "show me the code")',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: '{ targets: [{ symbol? | name? | file+line+col }] } — up to 20',
  example: {
    args: { targets: [{ name: 'createEngine' }, { symbol: 'ts:Button@src/Button.tsx:1:14' }] },
  },
  notes: [
    'one call returns N bodies (≤20) — the "show me the code" call, instead of N Reads.',
    'unresolvable/ambiguous targets come back under unresolved; a moved held-SymbolId is restated as rebound on its entry (never silent); extra definitions (overloads/merging) are listed.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const sources: JsonValue[] = [];
    const unresolved: JsonValue[] = [];
    try {
      for (const target of args.targets) {
        const outcome = ts.findDefinition(target);
        if (typeof outcome === 'string') {
          unresolved.push({ target: describeTarget(target), reason: outcome });
          continue;
        }
        const view = outcome.views[0];
        if (view === undefined) {
          unresolved.push({ target: describeTarget(target), reason: 'no definition found' });
          continue;
        }
        sources.push({
          id: view.id,
          name: view.name,
          kind: view.kind,
          // The full declaration span (§3.1); fall back to the name span if the decl node
          // couldn't be located — at worst the agent still gets a proof-carrying location.
          decl: view.decl ?? view.span,
          // §6: a rebind is stated, never silent. `source` is built for chained SymbolIds,
          // so a held handle whose file moved must say so per target.
          ...(outcome.rebind !== undefined && outcome.rebind.status === 'rebound'
            ? {
                rebound: {
                  from: outcome.rebind.from,
                  to: outcome.rebind.to.id,
                  confidence: outcome.rebind.confidence,
                },
              }
            : {}),
          // §3.4: overloads / interface+impl / declaration merging yield several defs —
          // showing only the first without saying so is a completeness lie.
          ...(outcome.views.length > 1
            ? {
                moreDefinitions: outcome.views.slice(1).map((v) => `${v.span.file}:${v.span.line}`),
              }
            : {}),
        });
      }
      return ok({
        sources,
        ...(unresolved.length > 0 ? { unresolved } : {}),
      });
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
