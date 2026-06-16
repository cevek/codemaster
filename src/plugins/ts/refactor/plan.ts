// The plain-data plan a structural refactor (move OR extract) hands the op layer to
// execute. Plain types only — no tree handles cross to ops. `move_file` populates `moves`;
// `extract_symbol` leaves `moves` empty and populates `newFiles` (the extracted file) +
// `contentWrites` (the trimmed source + consumer imports). Both reuse the same commit /
// typecheck / rollback machinery.

import type { RepoRelPath } from '../../../core/brands.ts';
import type { HandleRebind } from '../../../core/ids.ts';
import type { Capture } from './capture/types.ts';

/** One css-module import observed in the extracted file — the TS-domain analysis the op feeds
 *  to the scss plugin for co-extract (spec-css-coextract §2.3). */
export interface CssExtractCandidate {
  /** The default-import local name (`import <localName> from '…scss'`). */
  localName: string;
  /** The specifier verbatim in the extracted file (used to decide ALIAS-IMP). */
  specifier: string;
  /** Sheet path resolved relative to the extracted file via the tree; `undefined` when the
   *  specifier is aliased / the sheet isn't tracked (→ move nothing). */
  sheetRel?: RepoRelPath;
  /** Classes the extracted block references (move candidates). */
  refsInExtracted: string[];
  /** Classes the post-extract source still references (always left behind). */
  refsInRemaining: string[];
  /** The remaining source used the import non-trivially → treat every class as still-used. */
  remainingWildcard: boolean;
  /** The extracted block used the import non-trivially → co-extract must skip this import (it
   *  can't be repointed without risking a stranded non-literal access). */
  extractedWildcard: boolean;
}

/** Co-extract analysis attached to an extract plan when `css` is requested (§2.2 step 1). */
export interface CssExtractAnalysis {
  /** Current path of the freshly created extracted file (the .tsx the op rewrites). */
  extractedFile: RepoRelPath;
  /** The source file the symbol was extracted from — excluded from the shared-sheet
   *  "used by another importer" check (it's already covered by `refsInRemaining`). */
  sourceFile: RepoRelPath;
  candidates: CssExtractCandidate[];
}

export interface RefactorPlan {
  /** Proof-carrying rebind (§6) when the target was a stale SymbolId re-located by name —
   *  the op surfaces it on `Result.handle`, never silently. Absent for path-based ops. */
  rebind?: HandleRebind;
  /** Advisory notes the op surfaces verbatim (e.g. `change_signature` dropping a side-effecting
   *  argument the §2.8 typecheck can't see) — honest disclosure of a gate-invisible consequence
   *  (§3.6), never a silent edit. */
  notes?: readonly string[];
  /** Ordered `git mv` list (move only; extract leaves this empty). */
  moves: { from: RepoRelPath; to: RepoRelPath; kind: 'file' | 'dir' }[];
  /** Files to write fresh (no disk history) — e.g. an extract target. */
  newFiles: { path: RepoRelPath; content: string }[];
  /** Content to write at each file's CURRENT path (independent of `moves`). */
  contentWrites: { path: RepoRelPath; content: string }[];
  /** Old paths of moved-away files — tombstoned during the dry-run typecheck. */
  removed: RepoRelPath[];
  /** Post-edit content of changed TS files — the overlay for the dry-run typecheck. */
  overlayFiles: { path: RepoRelPath; content: string }[];
  /** Typecheck scope — every tracked TS file, so a missed rewrite never reads as clean. */
  checkPaths: RepoRelPath[];
  /** Per-file before/after for the unified diff (a pure move shows as a rename header). */
  diff: { from: RepoRelPath; to: RepoRelPath; before: string; after: string }[];
  /** Import-path capture sites (§ capture-safety): rewritten import specifiers that now resolve
   *  to a DIFFERENT same-named target than intended (the typecheck can't see a type-compatible
   *  one). Empty when every rewritten import still lands on its intended target. The op surfaces
   *  these on the envelope and refuses apply when non-empty. */
  captures: Capture[];
  /** Set when the extract edits came from the §4 patched-LS rescue rather than the project's
   *  own LS — surfaced as provenance on the op envelope (§3.3), never silent. */
  rescued?: boolean;
  /** Block-scoped css-module usage for the extracted file — present only when `extract_symbol`
   *  was asked to co-extract css (spec-css-coextract §2.2); the op joins it with the scss
   *  plugin and folds the result back into this plan. */
  cssExtract?: CssExtractAnalysis;
}
