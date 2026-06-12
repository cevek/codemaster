// `expand_type` — the LS's resolved type + docs at a symbol, PLUS a structural view:
// object members (name/optional/type/inherited) or union/intersection constituents, so
// expanding an interface returns its fields rather than just `interface X` (§3.3).

import { z } from 'zod';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tsTargetShape, requireTarget } from './ts-target.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT } from './ts-target.ts';

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** How deep to expand anonymous object-literal members (1 = top level only). */
    depth: z.number().int().min(1).max(3).optional(),
    /** Max members listed per object before the rest are summarized honestly. */
    memberLimit: z.number().int().positive().max(200).optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const expandTypeOp = defineOp({
  name: 'expand_type',
  summary:
    'Resolved type + docs of a symbol, with structural members / constituents (deep, from the live checker)',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} — plus { depth?: 1-3 (default 1), memberLimit?: number (default 40) }`,
  example: {
    args: { symbol: 'ts:Engine@src/daemon/engine.ts:70:7' },
    flags: { verbosity: 'full' },
  },
  notes: [
    'object types list members (name/optional/type, inherited flagged); unions/intersections list constituents; enums list members.',
    'depth (1-3) expands nested anonymous object literals; memberLimit caps the list and overflow is reported, never silently dropped.',
  ],
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const outcome = ts.expandType(args, {
        depth: args.depth ?? 1,
        memberLimit: args.memberLimit ?? 40,
      });
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
