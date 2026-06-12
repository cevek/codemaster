// The changed set on freshness drift (§3.5): `git diff --name-only <from> <to>` for
// the committed delta. Callers union this with the dirty paths of both fingerprint
// captures — a file that *was* dirty and is clean now has changed too (checkout,
// stash pop), and only the captures know that.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit } from './run.ts';

export async function gitDiffNames(
  root: string,
  fromHead: string,
  toHead: string,
): Promise<Result<readonly string[]>> {
  if (fromHead === toHead) return ok([]);
  if (fromHead === 'no-head' || toHead === 'no-head') {
    // No commit to diff against — callers fall back to "everything tracked changed".
    return ok([]);
  }
  const result = await runGit(root, ['diff', '--name-only', '-z', fromHead, toHead]);
  if (!isOk(result)) return fail(result.failure);
  return ok(result.data.split('\u0000').filter((p) => p.length > 0));
}
