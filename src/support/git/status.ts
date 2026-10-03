// `git status --porcelain` — one call yields adds/removes/modifies/renames and the
// untracked set: the working-tree half of the repo-global freshness fingerprint
// (§3.5). Parsed, not interpreted: rename lines contribute both sides (the old path
// disappeared, the new one appeared — both matter to a plugin's keyed state).

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { rebaseOnPrefix } from '../../common/git-path/rebase.ts';
import { runGit, type GitRunner } from './run.ts';
import { gitShowPrefix } from './show-prefix.ts';

export interface GitStatus {
  /** Every path under the workspace root the working tree differs on (relative to the
   *  workspace root, forward slashes), renames contributing both old and new names. Sorted, unique. */
  dirtyPaths: readonly string[];
  /** The same for paths of the repository outside the workspace root (`../…`), when the root is a
   *  subdirectory of its repository. Sorted, unique. */
  outsideRoot: readonly string[];
  /** The raw porcelain output (repository-wide) — feeds the fingerprint hash verbatim. */
  porcelain: string;
}

export async function gitStatus(root: string, git: GitRunner = runGit): Promise<Result<GitStatus>> {
  // -z: NUL-separated, no quoting/escaping of unusual filenames; renames carry the
  // second path as the following NUL field. --untracked-files=all surfaces files
  // inside untracked directories individually (an added file must trip freshness).
  const [result, prefix] = await Promise.all([
    git(root, ['status', '--porcelain', '-z', '--untracked-files=all']),
    gitShowPrefix(root, git),
  ]);
  if (!isOk(result)) return fail(result.failure);
  if (!isOk(prefix)) return fail(prefix.failure);
  const { inside, outside } = rebaseOnPrefix(parsePorcelainPaths(result.data), prefix.data);
  return ok({
    dirtyPaths: [...new Set(inside)].sort(),
    outsideRoot: [...new Set(outside)].sort(),
    porcelain: result.data,
  });
}

/** Every path a `status --porcelain -z` output names, toplevel-relative as git prints them. */
export function parsePorcelainPaths(porcelain: string): string[] {
  const fields = porcelain.split('\u0000');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field.length < 4) continue;
    const xy = field.slice(0, 2);
    paths.push(field.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      // Rename/copy: the next NUL field is the source path.
      const source = fields[i + 1];
      if (source !== undefined && source.length > 0) paths.push(source);
      i++;
    }
  }
  return paths;
}
