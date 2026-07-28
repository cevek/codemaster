// `find_definition` — passthrough to `ts.findDefinition` (§5-L3). A rebound handle
// surfaces on `Result.handle`, never silently (§6).

import { z } from 'zod';
import { forceFlagGuardNotOverridable } from './force-flag.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { isBareNameTarget, type TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { withUndiscoveredHint, definitionFloor, searchCapFloor } from './no-symbol-hint.ts';
import { TS_TARGET_HINT, tsTargetShape, requireTarget, tsTargetIntake } from './ts-target.ts';
import { TS_TARGET_ONE_OF } from './ts-target.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { isFanCapableTarget } from './guard/fan-capable.ts';

// The shared ts-target schema PLUS `force` (t-679091): a bare-`name` find_definition resolves via
// `resolveByName`→`searchSymbols`, which fans navto across every program (the OOM surface), so it is
// size-guarded like the reference-fanout ops — `force:true` does NOT override it (t-693742). The symbolId/position/name+file
// paths are single-program-exact and never guarded, so the extra field is inert for them.
const argsSchema = z
  .strictObject({ ...tsTargetShape, force: forceFlagGuardNotOverridable() })
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const findDefinitionOp = defineOp({
  name: 'find_definition',
  summary: 'Resolve a symbol to its definition site(s), proof-carrying',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: TS_TARGET_HINT,
  intake: tsTargetIntake,
  requiredOneOf: TS_TARGET_ONE_OF,
  example: { args: { file: 'src/app.ts', line: 12, col: 8 } },
  notes: [
    'verbosity: terse = location only · normal = + the declaration header · full = + the whole body (signature+body, not an echo of the name).',
    'a BARE-`name` target, or a `symbolId` whose file moved (the §6 rebind), resolves via a repo-wide navto fan-out; on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000) it REFUSES to warm (would OOM-kill the daemon) and names why the repo was not auto-escalated into a killable child (`force:true` does NOT override). A file+line+col / name+file target is single-program-exact and is never guarded.',
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
    // and is NEVER guarded. `force` does NOT override it (t-693742); process-mode + an estimate failure fall through.
    if (isFanCapableTarget(args)) {
      const refusal = semanticFanoutRefusal(ctx, ts, args.force, args);
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
      // MIS-target, not a proven answer. Fires ONLY on name-WITHOUT-a-file-pin (`isBareNameTarget`,
      // the SAME predicate the resolve-time disclosure gates on — a second spelling drifts in both
      // directions at once): a symbolId/position is EXACT, and a `name`+`file` target is file-pinned,
      // an equally exact resolution where a cross-program twin is irrelevant, so a floor there would
      // dress a COMPLETE answer as partial (the §3.6 inverse).
      //
      // FIELDS only. Both floors state the same thing — the target may not be the only symbol of
      // this name — and that claim is stated in words ONCE, on the envelope, by the resolve. What
      // rides `data` is the machine-readable verdict, verdict-first (§12) so it leads and survives
      // the char-cap.
      const floor = definitionFloor(isBareNameTarget(args) ? ts.undiscoveredProgramLabels() : []);
      // The second, independent cause of that same claim: the candidate set was cut before every
      // same-named declaration was seen (§3.4).
      const capFloor = searchCapFloor(outcome.searchTruncated === true);
      return ok(
        {
          ...capFloor.fields,
          ...floor.fields,
          definitions: outcome.views.map((v) => tag('symbol', v)),
        },
        outcome.rebind !== undefined ? { handle: outcome.rebind } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
