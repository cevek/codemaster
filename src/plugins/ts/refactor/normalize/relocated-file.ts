// Post-LS text normalizers applied to the EXTRACTED new file (`extract_symbol`) before its content is
// read into the plan. Both fixes are scoped to this one generated file — never the source or unrelated
// importers. Import folding lives ONLY here: extract is the path where the LS actually emits a
// same-module duplicate (a default + a named statement). `move_symbol` does NOT fold — the LS already
// merges a move's own imports, so a fold there would only touch PRE-EXISTING dest duplicates the move
// didn't create (an unrequested refactor; backlog). `move_symbol` applies `reattachLeadingDoc` alone.
// Run before `assemblePlan`'s import rewrite; the rare different-specifier-same-after-rewrite duplicate
// it can't yet see is a backlog residual.

import { reattachLeadingDoc } from './reattach-doc.ts';
import { foldSameModuleImports } from './fold-imports.ts';

/** Reattach the moved symbol's leading doc (when it has a name + a measured source gap) and fold any
 *  same-module duplicate imports in the new file. Import folding is name-independent, so it always
 *  runs. */
export function normalizeExtractedContent(
  content: string,
  movedName: string | undefined,
  sourceGap: number | undefined,
): string {
  const reattached =
    movedName !== undefined && sourceGap !== undefined
      ? reattachLeadingDoc(content, movedName, sourceGap)
      : content;
  return foldSameModuleImports(reattached);
}
