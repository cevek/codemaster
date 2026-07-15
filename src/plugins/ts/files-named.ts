// The `search_symbol` 0-match file/module hint (t-517121): git-tracked SOURCE files whose basename
// stem matches the query. When a name resolves to NO symbol but DOES name a file, the agent almost
// certainly wants that module — a hint saves a fallback grep. The git listing (not the loaded
// programs) is the source on purpose: the motivating file lives under an UNDISCOVERED program (which
// is WHY no symbol was found), so a program-based lookup would miss exactly the case that matters.
//
// Bounded / never-hang (§1/§19): reuses the SAME `gitSourceFilesSync` primitive as
// list_symbols/syntactic-search (each git call deadline-guarded, caught) — no fresh per-call FS
// tree-walk. Best-effort: a git failure yields no hint (empty), never a throw or a fabricated path.

import path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';
import { isOk } from '../../common/result/narrow.ts';
import { brandGitPath } from '../../support/fs/canonicalize.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import { isScannedSourcePath } from './syntactic-cache.ts';

/** Cap the NAMED files — a hint, not an inventory; many same-stem files means "look in `list`".
 *  `total` still counts every match past the cap so the note reports the truncation (§3.4). */
const MAX_FILES = 5;

/** The module-name stem: the basename minus its FINAL extension, lower-cased —
 *  `apps/web/src/lib/buildView.ts` → `buildview`, `foo.test.ts` → `foo.test`. Only the last extension
 *  is stripped, so the stem IS the module specifier's base (what an `import './foo.test'` names) — a
 *  bare `foo` query then does NOT spuriously match `foo.test.ts`, and the hint's "a source file named
 *  'X'" stays accurate. (`.d.ts` never reaches here — `isScannedSourcePath` excludes declarations.) */
function stem(rel: string): string {
  const base = path.basename(rel);
  const ext = path.extname(base);
  return (ext === '' ? base : base.slice(0, -ext.length)).toLowerCase();
}

/** Git-tracked SOURCE files whose module-name stem equals `name` (case-insensitive) — `files` capped
 *  at `MAX_FILES`, `total` the full count so the caller can report a §3.4-honest truncation. Exact-stem
 *  only (proof-carrying, low-noise): the motivating `buildView` → `buildView.ts` is an exact match, and
 *  a fuzzy widen would drag in unrelated files. Empty on a git failure or no match. */
export function filesNamedLike(
  root: string,
  name: string,
): { files: RepoRelPath[]; total: number } {
  const target = name.toLowerCase();
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return { files: [], total: 0 }; // best-effort: no hint beats a fabricated one
  const files: RepoRelPath[] = [];
  let total = 0;
  for (const rel of listing.data) {
    if (!isScannedSourcePath(rel)) continue;
    if (stem(rel) !== target) continue;
    total++;
    if (files.length < MAX_FILES) files.push(brandGitPath(rel)); // keep counting — no silent cutoff
  }
  return { files, total };
}
