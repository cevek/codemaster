// A repo-relative pathInclude/pathExclude predicate — the scope filter a whole-program scan op
// (`construction_sites`, `discrimination_sites`, …) applies to narrow the files it walks. Pure over
// `matchesPathFilter`; shared so the two type-aware scan ops filter identically (no drift).

import type { RepoRelPath } from '../../core/brands.ts';
import { matchesPathFilter } from '../../common/glob/path-filter.ts';

/** `include`/`exclude` glob predicate over a RepoRelPath — a file is in scope when it matches every
 *  non-empty `include` (if any) and no `exclude`. Empty/absent filters do not constrain. */
export function pathScopePredicate(
  pathInclude: readonly string[] | undefined,
  pathExclude: readonly string[] | undefined,
): (rel: RepoRelPath) => boolean {
  return (rel) => {
    if (
      pathInclude !== undefined &&
      pathInclude.length > 0 &&
      !matchesPathFilter(rel, pathInclude)
    ) {
      return false;
    }
    if (
      pathExclude !== undefined &&
      pathExclude.length > 0 &&
      matchesPathFilter(rel, pathExclude)
    ) {
      return false;
    }
    return true;
  };
}
