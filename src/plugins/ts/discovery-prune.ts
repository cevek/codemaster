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

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import { isScannedSourcePath } from './syntactic-cache.ts';
import type { TsProgram } from './program/queryable-program.ts';

interface RelHost {
  relOf(abs: string): string;
}

const JS_EXT = /\.(js|jsx|mjs|cjs)$/;

/** Gate 1 + Gate 2 over the loaded programs (see file header), read from cheap `fileNames()` globs
 *  — NO program build. `'out-of-root'` when ANY program reaches outside root (gate 2: don't prune,
 *  the navto path has no out-of-root disclosure); else `{ includeJs }` where `includeJs` is true iff
 *  some program parses `.js` (gate 1: JS is navto-visible only there). */
function gate1And2(
  programs: readonly TsProgram[],
  rootPrefix: string,
): { includeJs: boolean } | 'out-of-root' {
  let includeJs = false;
  for (const p of programs) {
    for (const abs of p.fileNames()) {
      const posix = abs.replace(/\\/g, '/');
      if (!posix.startsWith(rootPrefix)) return 'out-of-root';
      if (JS_EXT.test(posix)) includeJs = true;
    }
  }
  return { includeJs };
}

/** The in-root git source surface (rel posix) a navto fan-out must cover, listed WITHOUT a program
 *  build (one cheap git call, §19). `.ts/.tsx/.mts/.cts` minus `.d.ts` always; JS extensions only
 *  when `includeJs` (some loaded program has `allowJs` — else navto surfaces no `.js`). `fail` on a
 *  non-git root / git failure / empty surface — the caller decides: the build-based coverage test
 *  declines to prune (conservative), the cheap pre-warm estimate falls through to warm (§19). */
function discoverySurface(root: string, includeJs: boolean): Result<ReadonlySet<string>> {
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return fail(listing.failure);
  const set = new Set<string>();
  for (const rel of listing.data) {
    if (isScannedSourcePath(rel) || (includeJs && JS_EXT.test(rel))) set.add(rel);
  }
  if (set.size === 0) return fail({ tool: 'git', message: 'empty in-root git source surface' });
  return ok(set);
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
  const gates = gate1And2(programs, rootPrefix);
  if (gates === 'out-of-root') return false;
  const surface = discoverySurface(root, gates.includeJs);
  if (!surface.ok) return false;
  const primaryRels = new Set<string>();
  for (const sf of program.getSourceFiles()) primaryRels.add(host.relOf(sf.fileName));
  for (const rel of surface.data) if (!primaryRels.has(rel)) return false;
  return true;
}

/** The PRE-WARM (no-build) sibling of `coversInRootSurface`: will navto prune to the primary alone?
 *  Reads the primary's `fileNames()` GLOB instead of the built `getSourceFiles()` — and since
 *  `fileNames() ⊆ getSourceFiles()`, a fileNames-⊇-surface result is a SOUND-SUFFICIENT predictor
 *  (fileNames covers ⇒ the built program covers ⇒ the real prune engages). Result-typed to
 *  distinguish the two `false` shapes the guard must treat differently: `ok(false)` = a genuine
 *  won't-prune (out-of-root, or the primary really doesn't cover → the guard sums the fan-out);
 *  `fail` = a git hiccup / empty surface, i.e. can't-estimate → the guard falls THROUGH to warm
 *  (never over-refuses a legitimate search on a git error — the guard is an optimization, not a
 *  correctness gate, §19). Never builds a program → the guard cannot warm the very LS it protects. */
export function coversInRootSurfaceCheap(
  programs: readonly TsProgram[],
  host: RelHost,
  root: string,
): Result<boolean> {
  const primary = programs[0];
  if (primary === undefined) return ok(false);
  const rootPrefix = `${root.replace(/\\/g, '/')}/`;
  const gates = gate1And2(programs, rootPrefix);
  if (gates === 'out-of-root') return ok(false);
  const surface = discoverySurface(root, gates.includeJs);
  if (!surface.ok) return fail(surface.failure);
  const primaryRels = new Set<string>();
  for (const abs of primary.fileNames()) primaryRels.add(host.relOf(abs));
  for (const rel of surface.data) if (!primaryRels.has(rel)) return ok(false);
  return ok(true);
}
