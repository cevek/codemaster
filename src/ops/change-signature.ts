// `change_signature` — remove or reorder a function's positional parameters at the
// declaration AND every call site (§7). v1 covers the two well-defined positional ops; the
// shared `applyRefactorPlan` runs the §2.8 dry-run/apply/typecheck/rollback contract, and a
// wrong arg rewrite that breaks compilation is refused / rolled back, never silently applied.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import { fail } from '../common/result/construct.ts';
import { failTimeoutOr } from './refactor-timeout.ts';
import type { TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget, targetOf, tsTargetIntake } from './ts-target.ts';
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
  intake: tsTargetIntake,
  example: { args: { name: 'greet', removeParam: 1 } },
  notes: [
    'positional params only; pass removeParam (0-based index) OR reorder (a full permutation of param indices). Renaming a param is rename_symbol, not this.',
    'CONSERVATIVE: refuses the whole op (rather than risk a silent mis-bind the typecheck cannot catch) if any use is a non-call value/JSX/new, a spread-arg call, or a reorder over a call that omits trailing args. It has no type-compatible-capture check — it refuses conservatively on any use it cannot faithfully rewrite.',
    'gate & cross-program: dry-run→typecheck→rollback gate; call sites are rewritten across ALL loaded programs (or the op refuses); in-transaction call-site fan-out is primary-only (the cumulative gate still refuses a cross-program dangle) — see concepts (mutating-gate, cross-program-limits).',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let plan: RefactorPlan | string;
    try {
      plan = await ts.planChangeSignature(
        targetOf(args),
        {
          ...(args.removeParam !== undefined ? { removeParam: args.removeParam } : {}),
          ...(args.reorder !== undefined ? { reorder: args.reorder } : {}),
        },
        undefined,
        ctx.deadline,
      );
    } catch (thrown) {
      return failTimeoutOr('change_signature', 'ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'change-signature',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
