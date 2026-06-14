// The repo-global change fingerprint — the strong half of the read-time freshness
// guarantee (§3.5): `git rev-parse HEAD` + `git status --porcelain` in one capture.
// Repo-global on purpose: it catches a file an answer *omitted* but shouldn't have
// (watcher-missed add / checkout), which an answer-scoped check would miss.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit, type GitRunner } from './run.ts';
import { gitStatus } from './status.ts';

export interface GitRepoFingerprint {
  /** Commit id of HEAD, or 'no-head' on an unborn branch. */
  head: string;
  /** Working-tree-dirty paths at capture time (see status.ts). */
  dirtyPaths: readonly string[];
  /** Equality-comparable capture of (HEAD, porcelain). */
  fingerprint: string;
}

export async function gitRepoFingerprint(
  root: string,
  git: GitRunner = runGit,
): Promise<Result<GitRepoFingerprint>> {
  const [headResult, statusResult] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    gitStatus(root, git),
  ]);
  // An unborn branch (fresh `git init`) has no HEAD — still a valid git repo.
  const head = isOk(headResult) ? headResult.data.trim() : 'no-head';
  if (!isOk(statusResult)) return fail(statusResult.failure);

  const { dirtyPaths, porcelain } = statusResult.data;
  return ok({ head, dirtyPaths, fingerprint: `${head}\n${porcelain}` });
}
