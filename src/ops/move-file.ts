// `move_file` — move a file/folder and rewrite every importer (§7), highest blast radius.
// The `ts` plugin plans the move (tree + sibling carry + import rewrite via the project's own
// resolver); the shared `applyRefactorPlan` runs the §2.8 dry-run/apply/typecheck/rollback
// contract (history-preserving `git mv`, rollback to the pre-op state on failure).

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import type { TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { applyRefactorPlan } from './refactor-plan-apply.ts';

const moveArgsSchema = z.strictObject({
  source: z.string().min(1),
  dest: z.string().min(1),
  dirtyOk: z.boolean().optional(),
});
type MoveArgs = z.infer<typeof moveArgsSchema>;

export const moveFileOp = defineOp<MoveArgs, JsonValue>({
  name: 'move_file',
  summary: 'Move a file/folder and rewrite every importer (dry-run unless apply:true)',
  mutating: true,
  requires: ['ts'],
  argsSchema: moveArgsSchema,
  argsHint: '{ source: RepoRelPath, dest: RepoRelPath (full new path), dirtyOk?: boolean }',
  example: { args: { source: 'src/old/Button.tsx', dest: 'src/ui/Button.tsx' } },
  notes: [
    'dest is the full new path, not a directory. git mv preserves history; a .module.scss/.css sibling is carried with the file.',
    'dry-run writes nothing; apply is refused only if the move INTRODUCES new typecheck errors (vs a pre-edit baseline — pre-existing repo errors ride along as a preExisting count), and rolls back to the pre-op state if the post-apply typecheck shows newly-introduced errors.',
    'capture-safe: each rewritten import is re-resolved over the post-move tree — if one lands on a DIFFERENT same-named, type-compatible export (a path-capture the typecheck cannot see) the sites are listed under `captures` and apply is REFUSED. summaryOnly:true returns the verdict + a per-file diffstat instead of the full diff.',
    'cross-program: an importer in a `test/**` file under a sibling tsconfig is repointed too (not left dangling), and the typecheck gate runs on every affected program — including the program whose glob owns the DEST, so a moved file erroneous under a disjoint dest tsconfig (e.g. a divergent `lib`/`strict`) is refused, not silently applied.',
    'cross-program LIMITS: (a) the capture-safety check (the type-compatible silent re-bind on a rewritten import) runs on the PRIMARY program ONLY. (b) inside a `transaction` the cross-program write-site fan-out is OFF: a step rewrites primary-program sites only, though the cumulative §2.8 gate still fans across every program and refuses a cross-program dangle.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let plan: RefactorPlan | string;
    try {
      plan = await ts.planMove(args.source as RepoRelPath, args.dest as RepoRelPath);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'move',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
