// The cheap, §19-bounded pre-warm PEAK estimate behind the `search_symbol` size guard (t-333163,
// made pruning-aware by t-399909): how much the default navto path would ACTUALLY build — the
// POST-PRUNING peak in file-count — WITHOUT warming the LS / building any type-checker.
//
// Why peak, not total surface: after the t-167395 discovery prune, a LOOSE-ROOT monorepo warms only
// ONE program (the primary already subsumes the whole in-root surface), so its peak is a single
// ~1 GB program even though the total surface is huge (backoffice2: 6107 files, ~0.98 GB — safe).
// Gating on total over-refused it. Conversely a `references` monorepo does NOT prune, so ALL its
// programs build together and memory ≈ the SUM of their file-sets (each program owns its own
// checker) — the union-surface undercounts the overlap and would miss that OOM. So:
//   peakFiles = willPrune ? primary.fileNames().length : Σ program.fileNames().length
// A single-program repo (no siblings) trivially peaks at the primary alone.
//
// FILE-COUNT, not bytes: per-file sizing means a stat / `cat-file` over the surface = O(surface)
// per-call work = the same hang-class §19 forbids. The peak reads `fileNames()` (globbed at program
// construction, no build) + one git listing for the prune predicate — both §19-bounded.
//
// The prune predicate (`coversInRootSurfaceCheap`) is a SOUND-SUFFICIENT no-build stand-in for the
// real coverage test (fileNames ⊆ getSourceFiles), and it distinguishes a git hiccup (→ `fail`, the
// guard falls through to warm) from a genuine won't-prune (→ sum the fan-out). See discovery-prune.ts.

import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import { coversInRootSurfaceCheap } from './discovery-prune.ts';
import { isScannedSourcePath } from './syntactic-cache.ts';
import type { TsProgram } from './program/queryable-program.ts';

interface RelHost {
  relOf(abs: string): string;
}

/** Count the git-tracked source files under `root` (`.ts/.tsx/.mts/.cts`, minus `.d.ts`) — the total
 *  in-root source surface, one cheap git listing, NEVER parses or warms. Used by the SEMANTIC fan-out
 *  guard (t-679091), whose decl→usage fan-out never prunes; the `search_symbol` guard gates on the
 *  pruning-aware PEAK below instead. A git failure surfaces honestly so the caller can fall through. */
export function estimateSourceFileCount(root: string): Result<number> {
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return fail(listing.failure);
  let count = 0;
  for (const rel of listing.data) if (isScannedSourcePath(rel)) count += 1;
  return ok(count);
}

/** The post-pruning peak the guard compares against `searchWarmPeakMaxFiles`. `pruned` is surfaced so
 *  the refusal message can say WHY the peak is what it is (a single pruned program vs a summed
 *  multi-program fan-out). NEVER warms the LS — reads `fileNames()` globs + one git listing. A git
 *  hiccup in the prune predicate surfaces as `fail` so the guard falls through to warm (§19). */
export function estimateSearchPeak(
  programs: readonly TsProgram[],
  host: RelHost,
  root: string,
): Result<{ peakFiles: number; pruned: boolean }> {
  const primary = programs[0];
  if (primary === undefined) return ok({ peakFiles: 0, pruned: false });
  const primaryFiles = primary.fileNames().length;
  // A single program can only ever build itself — no fan-out to prune, peak is the primary.
  if (programs.length === 1) return ok({ peakFiles: primaryFiles, pruned: false });
  const cover = coversInRootSurfaceCheap(programs, host, root);
  if (!cover.ok) return fail(cover.failure); // git hiccup → guard falls through to warm (not a gate)
  if (cover.data) return ok({ peakFiles: primaryFiles, pruned: true });
  // No prune: every program builds → memory ≈ Σ of their file-sets (each owns its own checker).
  let sum = 0;
  for (const p of programs) sum += p.fileNames().length;
  return ok({ peakFiles: sum, pruned: false });
}
