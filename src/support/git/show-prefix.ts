// The workspace root's position inside its git repository (`''` at the toplevel, else `dir/sub/`) —
// what `rebaseOnPrefix` needs to turn git's toplevel-relative paths into workspace-relative ones.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit, runGitSync, type GitRunner } from './run.ts';

export async function gitShowPrefix(
  root: string,
  git: GitRunner = runGit,
): Promise<Result<string>> {
  const r = await git(root, ['rev-parse', '--show-prefix']);
  return isOk(r) ? ok(r.data.trim()) : fail(r.failure);
}

export function gitShowPrefixSync(root: string, timeoutMs: number): Result<string> {
  const r = runGitSync(root, ['rev-parse', '--show-prefix'], { timeoutMs });
  return isOk(r) ? ok(r.data.trim()) : fail(r.failure);
}
