// Git working-tree mutations for the move/refactor ops: history-preserving `mv`, and an
// index reset used by rollback. Each is wrapped → `ToolFailure`, never a throw (§3.6). The
// rollback restores PRE-OP content (not HEAD), so it is dirty-safe — see `refactor-commit`.

import type { Result } from '../../core/result.ts';
import { ok, fail } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit } from './run.ts';

/** `git mv from to` — records a rename so `git log --follow` keeps history. */
export async function gitMove(root: string, from: string, to: string): Promise<Result<true>> {
  const r = await runGit(root, ['mv', from, to]);
  return isOk(r) ? ok(true) : fail(r.failure);
}

/** Unstage `paths` (index → HEAD), leaving the worktree untouched. Used by rollback to undo
 *  a staged `git mv` so the post-rollback `git status` reflects the restored worktree, not a
 *  dangling staged rename. `--` guards against a path that looks like a flag. */
export async function gitUnstage(root: string, paths: readonly string[]): Promise<Result<true>> {
  if (paths.length === 0) return ok(true);
  const r = await runGit(root, ['reset', '-q', 'HEAD', '--', ...paths]);
  return isOk(r) ? ok(true) : fail(r.failure);
}
