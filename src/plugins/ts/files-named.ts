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

/** Cap the named files — a hint, not an inventory; many same-stem files means "look in `list`". */
const MAX_FILES = 5;

/** The basename WITHOUT its extension(s), lower-cased — `apps/web/src/lib/buildView.ts` → `buildview`.
 *  Strips a compound `.d.ts`-style tail one dot at a time via `path.extname` so `foo.test.ts` → `foo`. */
function stem(rel: string): string {
  let base = path.basename(rel);
  for (let ext = path.extname(base); ext !== ''; ext = path.extname(base)) {
    base = base.slice(0, -ext.length);
  }
  return base.toLowerCase();
}

/** Up to `MAX_FILES` git-tracked SOURCE files whose basename stem equals `name` (case-insensitive).
 *  Exact-stem only (proof-carrying, low-noise): the motivating `buildView` → `buildView.ts` is an
 *  exact match, and a fuzzy widen would drag in unrelated files. Empty on a git failure or no match. */
export function filesNamedLike(root: string, name: string): RepoRelPath[] {
  const target = name.toLowerCase();
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return []; // best-effort: no hint beats a fabricated one
  const out: RepoRelPath[] = [];
  for (const rel of listing.data) {
    if (!isScannedSourcePath(rel)) continue;
    if (stem(rel) !== target) continue;
    out.push(brandGitPath(rel));
    if (out.length >= MAX_FILES) break;
  }
  return out;
}
