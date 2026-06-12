// `expand_type` — the LS's resolved type + docs at a symbol (quick-info depth;
// deep structural expansion grows in Phase 1 follow-ups).

import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT, tsTargetSchema } from './ts-target.ts';

export const expandTypeOp = defineOp({
  name: 'expand_type',
  summary: 'Resolved type signature + docs of a symbol, from the live type checker',
  mutating: false,
  requires: ['ts'],
  argsSchema: tsTargetSchema,
  argsHint: TS_TARGET_HINT,
  example: `op({name:'expand_type', args:{symbol:'ts:Engine@src/daemon/engine.ts:70:7'}})`,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const outcome = ts.expandType(args);
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      return ok(
        { ...outcome.view },
        outcome.rebind !== undefined ? { handle: outcome.rebind } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
