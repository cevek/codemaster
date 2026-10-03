// `git diff --name-only <ref>` — the changed set for `affected({since})`: every path that
// differs between <ref> and the WORKING TREE (two-dot semantics — includes uncommitted
// edits), UNIONED with the untracked set (a brand-new test file is untracked and never
// shows in a diff). Distinct from `gitDiffNames` (commit-to-commit, no untracked). The op
// states the two-dot/working-tree semantics in its output so a caller expecting merge-base
// (`ref...HEAD`) is never silently surprised.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { rebaseOnPrefix } from '../../common/git-path/rebase.ts';
import { runGit, type GitRunner } from './run.ts';
import { gitShowPrefix } from './show-prefix.ts';
import { gitStatus } from './status.ts';

/** `inside`: workspace-root-relative; `outside`: changed paths of the repository outside a
 *  subdirectory workspace root (`../…`). Each sorted, unique. */
export interface ChangedPaths {
  inside: readonly string[];
  outside: readonly string[];
}

export async function gitDiffAgainst(
  root: string,
  ref: string,
  git: GitRunner = runGit,
): Promise<Result<ChangedPaths>> {
  const [diff, prefix] = await Promise.all([
    git(root, ['diff', '--name-only', '-z', ref]),
    gitShowPrefix(root, git),
  ]);
  if (!isOk(diff)) return fail(diff.failure);
  if (!isOk(prefix)) return fail(prefix.failure);
  const rebased = rebaseOnPrefix(
    diff.data.split('\u0000').filter((p) => p.length > 0),
    prefix.data,
  );
  // Untracked files never appear in `git diff` — union the working-tree dirty set (which
  // includes them) so a freshly-added test file is part of the changed set.
  const status = await gitStatus(root, git);
  if (!isOk(status)) return fail(status.failure);
  return ok({
    inside: [...new Set([...rebased.inside, ...status.data.dirtyPaths])].sort(),
    outside: [...new Set([...rebased.outside, ...status.data.outsideRoot])].sort(),
  });
}
