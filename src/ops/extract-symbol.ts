// `extract_symbol` — move a top-level symbol to a new file via the LS "Move to a new file"
// refactor (§7), re-targeted to the requested `dest`. The `ts` plugin plans it (LS edits →
// tree → import rewrite); the shared `applyRefactorPlan` runs the §2.8 dry-run/apply/
// typecheck/rollback contract. The LS refusal shapes are surfaced honestly with their
// `ts-ls-failures` category (the patched-LS rescue, §4, and CSS co-extract are not yet wired).

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import type { TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget } from './ts-target.ts';
import { applyRefactorPlan } from './refactor-plan-apply.ts';

const extractArgsSchema = z
  .strictObject({
    ...tsTargetShape,
    dest: z.string().min(1),
    dirtyOk: z.boolean().optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });
type ExtractArgs = z.infer<typeof extractArgsSchema>;

export const extractSymbolOp = defineOp<ExtractArgs, JsonValue>({
  name: 'extract_symbol',
  summary: 'Move a top-level symbol to a new file, rewriting imports (dry-run unless apply:true)',
  mutating: true,
  requires: ['ts'],
  argsSchema: extractArgsSchema,
  argsHint:
    "{ symbol?: 'ts:…' | name?: string | file+line+col, dest: RepoRelPath, dirtyOk?: boolean }",
  example: { args: { name: 'Helper', dest: 'src/lib/helper.ts' } },
  notes: [
    'dest is the full new file path; .ts is coerced to .tsx when the body has JSX. The source keeps importing the extracted symbol from its new home.',
    'when the LS refuses (e.g. several cross-referencing declarations in one file) the failure is reported with its ts-ls category — never a half-written file. CSS co-extract and the patched-LS rescue are not yet wired.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let plan: RefactorPlan | string;
    try {
      plan = await ts.planExtract(
        { symbol: args.symbol, file: args.file, line: args.line, col: args.col, name: args.name },
        args.dest as RepoRelPath,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'extract',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
