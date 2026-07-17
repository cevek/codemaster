// `move_file` — move a file/folder and rewrite every importer (§7), highest blast radius.
// The `ts` plugin plans the move (tree + sibling carry + import rewrite via the project's own
// resolver); the shared `applyRefactorPlan` runs the §2.8 dry-run/apply/typecheck/rollback
// contract (history-preserving `git mv`, rollback to the pre-op state on failure).

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail } from '../common/result/construct.ts';
import { failTimeoutOr } from './refactor-timeout.ts';
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
  // §7 Postel: `from`/`to` is the intuitive spelling of the canonical `source`/`dest` (a recurring
  // miscall). Disclosed via Result.intake; the canonical schema stays the sole gate.
  intake: { aliases: { from: 'source', to: 'dest' } },
  example: { args: { source: 'src/old/Button.tsx', dest: 'src/ui/Button.tsx' } },
  notes: [
    'dest is the full new path, not a directory. git mv preserves history; a .module.scss/.css sibling is carried with the file.',
    'capture-safe: each rewritten import is re-resolved over the post-move tree — if one lands on a DIFFERENT same-named, type-compatible export (a path-capture the typecheck cannot see) the sites are listed under `captures` and apply is REFUSED.',
    'gate & cross-program: dry-run→typecheck→rollback gate; importers are repointed across ALL loaded programs (the gate also runs on the dest-owning program); capture & in-transaction write-fan-out LIMITS apply — see concepts (mutating-gate, cross-program-limits).',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let plan: RefactorPlan | string;
    try {
      // §1 never-hang: bound the importer-rewrite planning by the op's budget → honest `timeout`
      // BEFORE any write (§7), never a hang on a high-blast-radius move.
      plan = await ts.planMove(
        args.source as RepoRelPath,
        args.dest as RepoRelPath,
        undefined,
        ctx.deadline,
      );
    } catch (thrown) {
      return failTimeoutOr('move_file', 'ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'move',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
    });
  },
});
