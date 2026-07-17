// t-167395 — navto DISCOVERY pruning (OOM survival on loose-root monorepos).
//
// `searchSymbols` fans navto across EVERY loaded program; on a repo whose loose root globs the
// whole tree (backoffice2: ~25 sibling/member/test programs) that forces them all to build in one
// heap → ~6.1 GB → hard V8 OOM → the in-process singleton daemon dies (§1). But those member
// programs contribute ZERO new symbols WHEN the primary already covers what they would surface: a
// file's NAMED DECLARATIONS come from parse+bind and are resolution-INDEPENDENT (`paths`/`baseUrl`
// change how imports RESOLVE, never what a file DECLARES), and the caller dedups by declaration
// site. So under coverage, navto over the primary ALONE is byte-identical to the full fan-out.
//
// The soundness invariant is `primary.getSourceFiles() ⊇ ⋃_sibling sibling.getSourceFiles()`. We
// prove it cheaply (no sibling build) with the in-root git source surface as a stand-in for "every
// file a program could surface", PLUS two gates that keep the surface a faithful upper bound of
// navto's actual recall — which is larger than in-root `.ts`:
//   1. `.js/.jsx/.mjs/.cjs` — navto surfaces these only under `allowJs`. So the surface includes
//      JS extensions IFF some loaded program parses `.js` (a `.js` in any program's fileNames).
//      No-allowJs repo (backoffice2: allowJs off) → JS excluded → still prunes; an allowJs sibling
//      over a non-allowJs primary → JS in surface, primary lacks it → covered=false → no prune.
//   2. out-of-root files — a `references:[{path:'../shared'}]` sibling loads files the git-at-root
//      listing cannot see. If ANY loaded program has a file outside root, disable the prune (the
//      navto path carries no disclosure, so an undisclosed out-of-root drop would be a §3.6 lie).
// Provably complete: any symbol a sibling surfaces lives in one of its source files → that file is
// in-root (gate 2) and of a parsed extension (gate 1) → it is in the surface → under coverage it is
// already a primary source file → already scanned. The OOM case (loose root) is the all-covered
// case; a proper `references` monorepo's primary does NOT cover → no prune → full fan-out (the
// t-000052 process-isolation backstop). DISCOVERY ONLY (§3.4): the prune sits on the name→DECL step
// (this navto); the decl→USAGE fan-out (find_usages) runs via `programsContaining`, never pruned.

import { isOk } from '../../common/result/narrow.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import { isScannedSourcePath } from './syntactic-cache.ts';
import type { TsProgram } from './program/queryable-program.ts';

interface RelHost {
  relOf(abs: string): string;
}

const JS_EXT = /\.(js|jsx|mjs|cjs)$/;

/** The in-root git source surface (rel posix) a navto fan-out must cover, listed WITHOUT a program
 *  build (one cheap git call, §19). `.ts/.tsx/.mts/.cts` minus `.d.ts` always; JS extensions only
 *  when `includeJs` (some loaded program has `allowJs` — else navto surfaces no `.js`). Empty on a
 *  non-git root / git failure → the coverage test then declines to prune (conservative). */
function discoverySurface(root: string, includeJs: boolean): ReadonlySet<string> {
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return new Set();
  const set = new Set<string>();
  for (const rel of listing.data) {
    if (isScannedSourcePath(rel) || (includeJs && JS_EXT.test(rel))) set.add(rel);
  }
  return set;
}

/** True when navto may safely prune to the primary program alone (see file header). Builds the
 *  primary program (the navto loop builds it anyway — memoized), reads its in-root source files, and
 *  checks ⊇-surface coverage under the two recall gates. `root` is threaded explicitly from the
 *  plugin (the established idiom) so the surface is measured against the SAME root the programs are
 *  built with. Conservative by construction: an unbuilt primary, an out-of-root program, an
 *  empty/unavailable surface, or ANY case/symlink mismatch → returns false → no prune. It can only
 *  ever err toward the full (correct) fan-out, never toward a false coverage claim that drops a symbol. */
export function coversInRootSurface(
  programs: readonly TsProgram[],
  host: RelHost,
  root: string,
): boolean {
  const primary = programs[0];
  const program = primary?.getProgram();
  if (program === undefined) return false;
  const rootPrefix = `${root.replace(/\\/g, '/')}/`;
  // Gate 2: any program reaching outside root can surface symbols the in-root surface can't account
  // for → don't prune (the navto path has no out-of-root disclosure). Gate 1: JS is navto-visible
  // only where some program parses it — detected by a `.js` in any program's tracked glob.
  let includeJs = false;
  for (const p of programs) {
    for (const abs of p.fileNames()) {
      if (!abs.replace(/\\/g, '/').startsWith(rootPrefix)) return false;
      if (JS_EXT.test(abs)) includeJs = true;
    }
  }
  const surface = discoverySurface(root, includeJs);
  if (surface.size === 0) return false;
  const primaryRels = new Set<string>();
  for (const sf of program.getSourceFiles()) primaryRels.add(host.relOf(sf.fileName));
  for (const rel of surface) if (!primaryRels.has(rel)) return false;
  return true;
}
