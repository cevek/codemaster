// `find_definition` — passthrough to `ts.findDefinition` (§5-L3). A rebound handle
// surfaces on `Result.handle`, never silently (§6).

import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { withUndiscoveredHint, definitionFloor } from './no-symbol-hint.ts';
import { TS_TARGET_HINT, tsTargetSchema, tsTargetIntake } from './ts-target.ts';

export const findDefinitionOp = defineOp({
  name: 'find_definition',
  summary: 'Resolve a symbol to its definition site(s), proof-carrying',
  mutating: false,
  requires: ['ts'],
  argsSchema: tsTargetSchema,
  argsHint: TS_TARGET_HINT,
  intake: tsTargetIntake,
  example: { args: { file: 'src/app.ts', line: 12, col: 8 } },
  notes: [
    'verbosity: terse = location only · normal = + the declaration header · full = + the whole body (signature+body, not an echo of the name).',
  ],
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
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
