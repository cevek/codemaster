// The host-shared `.gitignore`-aware junk set (§10 / t-019044): the files a loose tsconfig
// `include` glob would pull in but the project declares ignored. Factored out of `ls-host.ts` so the
// memoization + injectable seam are one cohesive unit: computed ONCE per structural reindex (cleared
// via `clear()` on reindex) and shared by every program's `loadFileList` — off the LS hot path, at
// the same cadence as the tsconfig re-glob it feeds (§19: never per-op/per-file, the hang class).

import { gitIgnoredSync } from '../../../support/git/ls-ignored-sync.ts';

/** Injectable seam for the junk set (default: the real sync `git ls-files`). A test passes a
 *  counting fake to PROVE the memoization fires once per structural reindex, never per-op (§19
 *  cadence guard) — the deps-bag seam idiom (like the watcher / Clock injections). */
export type IgnoredComputer = (root: string) => ReadonlySet<string>;

export interface IgnoredSet {
  /** The junk set for `root`, memoized: the first call computes (one git spawn), the rest reuse. */
  get(): ReadonlySet<string>;
  /** Drop the memo so the NEXT `get()` recomputes — called on reindex (a new/removed file or an
   *  edited `.gitignore` may change what git ignores). */
  clear(): void;
}

export function createIgnoredSet(
  root: string,
  computeIgnored: IgnoredComputer = gitIgnoredSync,
): IgnoredSet {
  let memo: ReadonlySet<string> | undefined;
  return {
    get: () => (memo ??= computeIgnored(root)),
    clear: () => {
      memo = undefined;
    },
  };
}
