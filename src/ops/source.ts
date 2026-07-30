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
import { runSourceSyntactic } from './source-syntactic.ts';
import { tsTargetShape, requireTarget } from './ts-target.ts';

const targetSchema = z.strictObject(tsTargetShape).refine(requireTarget.predicate, {
  message: requireTarget.message,
});

const argsSchema = z.strictObject({
  targets: z
    .array(targetSchema)
    .min(1, { message: 'pass at least one target' })
    .max(20, { message: 'at most 20 targets per call — split into batches, or chain SymbolIds' }),
  /** Opt-in AST-only body read (t-229522), symmetric with `search_symbol {syntactic:true}`: no program
   *  is built and the LS never warms, so it is an order of magnitude cheaper in heap+latency and cannot
   *  be killed by a heavy neighbour sharing a batch's heap. NOT a superset of the default: it prints
   *  the declaration AT the address instead of resolving the address to a definition elsewhere, and
   *  resolves no module specifier — both are reported as explicit misses. Default OFF (type-verified). */
  syntactic: z.boolean().optional(),
});

function describeTarget(t: TsTargetInput): string {
  if (t.symbolId !== undefined) return t.symbolId;
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
  argsHint: '{ targets: [{ symbolId? | name? | file+line+col }], syntactic?: boolean } — up to 20',
  // `targetArray` also enables the flat→targets[] collapse (§7 Postel): a flat single target
  // ({name}/{symbolId}/{file+line+col}, or {query} via the alias) or a {names:[…]} list is
  // gathered into `targets[]` when no explicit `targets` is passed — so `source` accepts the
  // same flat shape as every sibling lookup op, not the divergent `{targets:[…]}` alone.
  intake: {
    aliases: { symbols: 'targets', sites: 'targets', query: 'name', symbol: 'name' },
    targetArray: 'targets',
  },
  example: {
    args: { targets: [{ name: 'createEngine' }, { symbolId: 'ts:Button@src/Button.tsx:1:14' }] },
  },
  notes: [
    'one call returns N bodies (≤20) — the "show me the code" call, instead of N Reads.',
    'unresolvable/ambiguous targets come back under unresolved; a moved held-SymbolId is restated as rebound on its entry (never silent); extra definitions (overloads/merging) are listed. An ambiguity hidden BEHIND a cut candidate page resolves instead of failing, and rides the envelope disclosure (status → concepts:disclosure).',
    // §11: this hint lives in the STATIC schema/notes, like search_symbol's — an agent must be able to
    // reach for the cheap mode before the expensive one has failed, and after a fatal the daemon
    // cannot advise post-hoc. What to run when a call actually fails is the REFUSAL's job
    // (ops/guard/navigate.ts), emitted with this call's own args interpolated.
    'printing a body needs no type-check: `syntactic:true` reads it off the AST — no program build, no LS warm (an order of magnitude less heap/latency on a big repo, and it survives a batch whose other ops are heavy). It is NOT a superset of the default: it prints the declaration AT the address rather than resolving that address to a definition elsewhere, and it does not resolve a module specifier (an address on an `import {X}` line is reported as such, never printed as X); its scope is git-tracked source under the workspace root.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const sources: JsonValue[] = [];
    const unresolved: JsonValue[] = [];
    try {
      // Opt-in AST-only path: no program build, no LS warm. Deliberately NOT an automatic degrade —
      // the two paths resolve an address differently (above), so switching silently would change what
      // the same args MEAN. A failure of the default path is redirected here by navigate.ts.
      if (args.syntactic === true) return runSourceSyntactic(ts, args.targets);
      for (const target of args.targets) {
        const outcome = ts.findDefinition(target);
        if (typeof outcome === 'string') {
          unresolved.push({ target: describeTarget(target), reason: outcome });
          continue;
        }
        if ('unresolved' in outcome) {
          // §6: a chained handle whose symbol is gone — stated per target (status + reason),
          // never silently dropped or retargeted to a same-named other.
          unresolved.push({
            target: describeTarget(target),
            reason: outcome.unresolved,
            handle: { status: outcome.rebind.status },
          });
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
