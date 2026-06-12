// Resolve the git worktree root for a directory. "Not a git repo" is an expected
// answer (the freshness backstop then runs in mtime-fallback mode, §3.5), so the
// result distinguishes it from a real git failure.

import { isOk } from '../../common/result/narrow.ts';
import { canonicalizeRoot } from '../fs/canonicalize.ts';
import { runGit } from './run.ts';

export type RepoRootOutcome =
  | { state: 'git'; root: string }
  | { state: 'not-git' }
  | { state: 'error'; message: string };

export async function gitRepoRoot(dir: string): Promise<RepoRootOutcome> {
  const result = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!isOk(result)) {
    const message = result.failure.message;
    if (/not a git repository/i.test(message)) return { state: 'not-git' };
    return { state: 'error', message };
  }
  const canon = canonicalizeRoot(result.data.trim());
  if (!canon.ok) return { state: 'error', message: canon.message };
  return { state: 'git', root: canon.root };
}
