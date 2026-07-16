// The cheap, §19-bounded pre-warm size estimate behind the `search_symbol` size guard (t-333163):
// how many source files the default navto path would fan across — WITHOUT warming the LS or building
// any program. It lists the same §10 git-source surface the syntactic paths scan, so the estimate
// costs the two `git ls-files` calls that surface already pays once (never a `parseJsonConfigFileContent`
// full tree-scan — that is exactly the ls-host hang §19 — and never a Node stat-walk).
//
// FILE-COUNT, not bytes: bytes is a closer memory proxy but obtaining per-file sizes means a stat /
// `cat-file` over the WHOLE surface = O(surface) per-call work = the same hang-class §19 forbids. A git
// listing gives names cheaply but not sizes, so file-count is the only §19-safe estimate.
//
// It re-lists on every call rather than reading the parsed-surface cache (`SyntacticCache`): that slot
// is only trustworthy behind its repo-state key, and re-validating the key costs as much as this git
// listing does — so the "free cache read" is not actually free once freshness matters, and a
// stale-LOW count would UNDER-protect (permit a warm the guard should have refused = the exact OOM it
// exists to prevent). A fresh listing is simpler and always honest.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import { isScannedSourcePath } from './syntactic-cache.ts';

/** Count the git-tracked source files under `root` (`.ts/.tsx/.mts/.cts`, minus `.d.ts`) — the same
 *  surface the syntactic paths scan. One cheap git listing; NEVER parses or warms. A git failure
 *  surfaces honestly so the caller can decide (the guard falls through to warm rather than over-refuse
 *  on a git hiccup). */
export function estimateSourceFileCount(root: string): Result<number> {
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return fail(listing.failure);
  let count = 0;
  for (const rel of listing.data) if (isScannedSourcePath(rel)) count += 1;
  return ok(count);
}
