// `change_signature` — remove or reorder a function's positional parameters at the
// declaration AND every call site (§7). v1 covers the two well-defined positional ops; the
// shared `applyRefactorPlan` runs the §2.8 dry-run/apply/typecheck/rollback contract, and a
// wrong arg rewrite that breaks compilation is refused / rolled back, never silently applied.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import type { TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget, targetOf } from './ts-target.ts';
import { applyRefactorPlan } from './refactor-plan-apply.ts';

const changeArgsSchema = z
  .strictObject({
    ...tsTargetShape,
    removeParam: z.number().int().nonnegative().optional(),
    reorder: z.array(z.number().int().nonnegative()).optional(),
    dirtyOk: z.boolean().optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message })
  .refine((a) => (a.removeParam === undefined) !== (a.reorder === undefined), {
    message: 'pass exactly one of removeParam (index) or reorder (permutation of param indices)',
  });
type ChangeArgs = z.infer<typeof changeArgsSchema>;

export const changeSignatureOp = defineOp<ChangeArgs, JsonValue>({
  name: 'change_signature',
  summary: 'Remove or reorder a function’s parameters at the declaration and every call site',
  mutating: true,
  requires: ['ts'],
  argsSchema: changeArgsSchema,
  argsHint:
    "{ symbolId?: 'ts:…' | name?: string | file+line+col, removeParam?: number | reorder?: number[], dirtyOk?: boolean }",
  example: { args: { name: 'greet', removeParam: 1 } },
  notes: [
    'positional params only; pass removeParam (0-based index) OR reorder (a full permutation of param indices). Renaming a param is rename_symbol, not this.',
    'CONSERVATIVE: refuses the whole op (rather than risk a silent mis-bind the typecheck cannot catch) if any use is a non-call value/JSX/new, a spread-arg call, or a reorder over a call that omits trailing args.',
    'cross-program: call sites are found across ALL loaded programs — a `test/**` call under a sibling tsconfig is rewritten (or refuses if it cannot be), and the typecheck gate runs on every affected program.',
    'cross-program LIMIT: inside a `transaction` the cross-program call-site fan-out is OFF — a step rewrites primary-program calls only (the cumulative §2.8 gate still fans across every program and refuses a resulting cross-program dangle). change_signature has no type-compatible-capture check; it refuses conservatively on any use it cannot faithfully rewrite.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let plan: RefactorPlan | string;
    try {
      plan = await ts.planChangeSignature(targetOf(args), {
        ...(args.removeParam !== undefined ? { removeParam: args.removeParam } : {}),
        ...(args.reorder !== undefined ? { reorder: args.reorder } : {}),
      });
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'change-signature',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
