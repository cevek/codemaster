// `find_definition` — passthrough to `ts.findDefinition` (§5-L3). A rebound handle
// surfaces on `Result.handle`, never silently (§6).

import { z } from 'zod';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { withUndiscoveredHint, definitionFloor } from './no-symbol-hint.ts';
import { TS_TARGET_HINT, tsTargetShape, requireTarget, tsTargetIntake } from './ts-target.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { isFanCapableTarget } from './guard/fan-capable.ts';

// The shared ts-target schema PLUS `force` (t-679091): a bare-`name` find_definition resolves via
// `resolveByName`→`searchSymbols`, which fans navto across every program (the OOM surface), so it is
// size-guarded like the reference-fanout ops — `force:true` bypasses. The symbolId/position/name+file
// paths are single-program-exact and never guarded, so the extra field is inert for them.
const argsSchema = z
  .strictObject({ ...tsTargetShape, force: z.boolean().optional() })
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const findDefinitionOp = defineOp({
  name: 'find_definition',
  summary: 'Resolve a symbol to its definition site(s), proof-carrying',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: TS_TARGET_HINT,
  intake: tsTargetIntake,
  example: { args: { file: 'src/app.ts', line: 12, col: 8 } },
  notes: [
    'verbosity: terse = location only · normal = + the declaration header · full = + the whole body (signature+body, not an echo of the name).',
    "a BARE-`name` target, or a `symbolId` whose file moved (the §6 rebind), resolves via a repo-wide navto fan-out; on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000) it REFUSES to warm (would OOM-kill the daemon) and redirects to `daemon.isolation:'process'` (or `force:true`). A file+line+col / name+file target is single-program-exact and is never guarded.",
  ],
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // Pre-warm guard (t-679091), only for FAN-CAPABLE addressing — the targets that resolve via
    // `searchSymbols` = the all-program navto fan (the original t-167395 OOM) when Fix A's pruning
    // does not subsume: a bare `name` (`resolveByName`), OR a `symbolId` whose recorded position no
    // longer matches → the §6 REBIND branch (`resolveSymbolId`→`searchSymbols`, resolve-target.ts).
    // The rebind fan is conditional (a fresh handle resolves cheaply), but the op can't see that
    // pre-resolve, so it guards all symbolId lookups in-process-oversized (a false refusal redirects
    // honestly to process-mode — §1: refuse > crash; consistent with the unconditional fanout ops).
    // A file+line+col / name+file / file+line target is single-program-exact (no `searchSymbols`)
    // and is NEVER guarded. `force` bypasses; process-mode + estimate-failure fall through.
    if (isFanCapableTarget(args)) {
      const refusal = semanticFanoutRefusal(ctx, ts, args.force);
      if (refusal !== undefined) return fail(refusal);
    }
    try {
      const outcome = ts.findDefinition(args);
      if (typeof outcome === 'string')
        return fail({
          tool: 'ts-ls',
          message: withUndiscoveredHint(outcome, ts.undiscoveredProgramLabels()),
        });
      if ('unresolved' in outcome) {
        // §6: the held handle's symbol is gone — state it structurally on `handle`.
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      // §3.6 floor: a bare-NAME target resolved to a decl, but if a nested tsconfig is unloaded a
      // DISTINCT same-named symbol may live there — so this single/first definition is a possible
      // MIS-target, not a proven answer. Fires ONLY on name-WITHOUT-a-file-pin: a symbolId/position is
      // EXACT, and a `name`+`file` (or `name`+`file`+`line`) target is file-pinned — an equally exact
      // resolution where a cross-program twin is irrelevant, so it gets NO note (a floor there would
      // dress a COMPLETE answer as partial — the §3.6 inverse). Verdict-first (§12): the machine-
      // readable `complete:false`+`undiscoveredPrograms` LEAD and survive the char-cap; `definitions`
      // then the prose `!!` note trail (the note may truncate under a huge decl set — the load-bearing
      // verdict is the fields, not the prose).
      const nameOnly = args.name !== undefined && args.file === undefined;
      const floor = definitionFloor(nameOnly ? ts.undiscoveredProgramLabels() : []);
      return ok(
        {
          ...floor.fields,
          definitions: outcome.views.map((v) => tag('symbol', v)),
          ...(floor.note !== undefined ? { notes: [floor.note] } : {}),
        },
        outcome.rebind !== undefined ? { handle: outcome.rebind } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
