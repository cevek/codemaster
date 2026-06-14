// The plain-data plan a structural refactor (move OR extract) hands the op layer to
// execute. Plain types only — no tree handles cross to ops. `move_file` populates `moves`;
// `extract_symbol` leaves `moves` empty and populates `newFiles` (the extracted file) +
// `contentWrites` (the trimmed source + consumer imports). Both reuse the same commit /
// typecheck / rollback machinery.

import type { RepoRelPath } from '../../../core/brands.ts';
import type { HandleRebind } from '../../../core/ids.ts';

export interface RefactorPlan {
  /** Proof-carrying rebind (§6) when the target was a stale SymbolId re-located by name —
   *  the op surfaces it on `Result.handle`, never silently. Absent for path-based ops. */
  rebind?: HandleRebind;
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
}
