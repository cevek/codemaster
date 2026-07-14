// The full source-file surface for a syntactic (no-program) scan: every git-tracked file
// INCLUDING submodule contents (`--recurse-submodules`), UNION untracked-but-not-ignored files
// (`--others --exclude-standard`) — the §10 tracked surface a built TS program would see, listed
// WITHOUT building one. Two git calls because `--recurse-submodules` (crosses submodule
// boundaries, tracked only) is incompatible with `--others` (untracked, same-repo only); the
// union covers both. Git-ignored files drop from both, matching the §10 program file-set
// (tsconfig-include ∩ not-git-ignored) for files UNDER the root, so this covers navto's under-root
// scan surface — the honesty floor the `search_symbol` syntactic path rests on (t-515730). SCOPE
// (BLOCK 1): a git listing at the root cannot see a tsconfig `include`/`reference` reaching ABOVE
// the root (`../shared`); such outside-root files are NOT listed and the syntactic op discloses
// that scope (it never claims to cover them). Submodule coverage is load-bearing: a plain
// `git ls-files` misses a submodule source file the tsconfig globs, which navto returns → a §3.4
// miss (measured on a real monorepo).

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { runGitSync } from './run.ts';

// Bound each git call (§1 never-hang): a wedged git THROWS on timeout and is caught by runGitSync.
const GIT_TIMEOUT_MS = 15_000;
const NUL = String.fromCharCode(0);

export function gitSourceFilesSync(root: string): Result<readonly string[]> {
  const tracked = runGitSync(root, ['ls-files', '--recurse-submodules', '-z'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!isOk(tracked)) return fail(tracked.failure);
  const untracked = runGitSync(root, ['ls-files', '--others', '--exclude-standard', '-z'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!isOk(untracked)) return fail(untracked.failure);
  const set = new Set<string>();
  for (const p of tracked.data.split(NUL)) if (p.length > 0) set.add(p);
  for (const p of untracked.data.split(NUL)) if (p.length > 0) set.add(p);
  return ok([...set]);
}
