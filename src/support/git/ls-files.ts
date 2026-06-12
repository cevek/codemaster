// The exact ".gitignore-aware file listing": tracked + untracked-but-not-ignored, with
// git itself evaluating nested `.gitignore` and `!` negation. This is the listing the
// engine prefers; `support/fs/walk.ts` is the non-git fallback (its header explains
// why we never reimplement gitignore semantics by hand).

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit } from './run.ts';

export async function gitLsFiles(root: string): Promise<Result<readonly string[]>> {
  const result = await runGit(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (!isOk(result)) return fail(result.failure);
  return ok(result.data.split('\u0000').filter((p) => p.length > 0));
}
