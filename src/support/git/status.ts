// `git status --porcelain` — one call yields adds/removes/modifies/renames and the
// untracked set: the working-tree half of the repo-global freshness fingerprint
// (§3.5). Parsed, not interpreted: rename lines contribute both sides (the old path
// disappeared, the new one appeared — both matter to a plugin's keyed state).

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGit, type GitRunner } from './run.ts';

export interface GitStatus {
  /** Every path the working tree differs on (relative to the repo root, git-style
   *  forward slashes), renames contributing both old and new names. Sorted, unique. */
  dirtyPaths: readonly string[];
  /** The raw porcelain output — feeds the fingerprint hash verbatim. */
  porcelain: string;
}

export async function gitStatus(root: string, git: GitRunner = runGit): Promise<Result<GitStatus>> {
  // -z: NUL-separated, no quoting/escaping of unusual filenames; renames carry the
  // second path as the following NUL field. --untracked-files=all surfaces files
  // inside untracked directories individually (an added file must trip freshness).
  const result = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!isOk(result)) return fail(result.failure);

  const fields = result.data.split('\u0000');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;
    const xy = field.slice(0, 2);
    paths.add(field.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      // Rename/copy: the next NUL field is the source path.
      const source = fields[i + 1];
      if (source !== undefined && source.length > 0) paths.add(source);
      i++;
    }
  }
  return ok({ dirtyPaths: [...paths].sort(), porcelain: result.data });
}
