// Post-LS text normalizers applied to the EXTRACTED new file (`extract_symbol`) before its content is
// read into the plan. Both fixes are scoped to this one generated file — never the source or unrelated
// importers. Import folding here is unconditional: a fresh extracted file has no pre-existing imports,
// so every same-module duplicate the LS emits (a default + a named statement) is the extract's own.
// `move_symbol` folds the SAME way but guarded — the LS merges a move's own imports into dest's existing
// lines for relative/alias specifiers, yet for a BARE specifier (npm package) it leaves the move's
// default + an existing named (or two fresh-dest statements) as separate lines; `move-to-existing.ts`
// folds that move-created dup while excluding dest's PRE-EXISTING duplicates (its scoped-edit contract).
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
