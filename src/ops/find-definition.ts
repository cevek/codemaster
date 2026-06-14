// `find_definition` — passthrough to `ts.findDefinition` (§5-L3). A rebound handle
// surfaces on `Result.handle`, never silently (§6).

import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT, tsTargetSchema } from './ts-target.ts';

export const findDefinitionOp = defineOp({
  name: 'find_definition',
  summary: 'Resolve a symbol to its definition site(s), proof-carrying',
  mutating: false,
  requires: ['ts'],
  argsSchema: tsTargetSchema,
  argsHint: TS_TARGET_HINT,
  example: { args: { file: 'src/app.ts', line: 12, col: 8 } },
  notes: [
    'verbosity: terse = location only · normal = + the declaration header · full = + the whole body (signature+body, not an echo of the name).',
  ],
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const outcome = ts.findDefinition(args);
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      if ('unresolved' in outcome) {
        // §6: the held handle's symbol is gone — state it structurally on `handle`.
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      return ok(
        { definitions: outcome.views },
        outcome.rebind !== undefined ? { handle: outcome.rebind } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
