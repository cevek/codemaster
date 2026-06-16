// The §2.8 typecheck gate, fanned across EVERY affected program (spec Task G, for WRITES). A
// mutation resolved only through the primary LS leaves a sibling program (a `test/**` file under
// `tsconfig.test.json`) un-rewritten — and a primary-only gate never sees the resulting dangle.
// So the write gate runs the SAME overlay typecheck on each program the edit touches and merges
// the diagnostics; `buildTypecheckField` then diffs the merged baseline vs the merged overlay.
//
// THE INVARIANT (symmetry): the (program × file) pairs sampled for the baseline must be IDENTICAL
// to those sampled for the overlay — `buildTypecheckField`'s multiset diff is global, so a file
// seen by two programs contributes twice on BOTH sides and cancels. Two rules keep it symmetric:
//   1. A program is OWNED by a file when its built program contains it OR its config glob WOULD
//      (`mayContain` — existence-independent, so a not-yet-created move/extract DEST pulls in the
//      program whose glob owns it; a `containsFile`-only test is blind to a path that doesn't exist
//      yet → the moved file would be typechecked under PRIMARY options only → a missed dangle).
//   2. Each program is overlaid ONLY with the entries IT owns (and tombstoned only for removed
//      paths it owns). The overlay's `getScriptFileNames` force-adds every overlay key, so without
//      this filter a sibling would diagnose a file it doesn't own in the OVERLAY pass but not the
//      BASELINE pass (which `getSourceFile`-filters) → a pre-existing error mis-counts as introduced.
//      The genuinely-new DEST is the intended asymmetry: baseline can't contain a file that doesn't
//      exist, the overlay does → an error it introduces under the dest program's options is caught.
// Each program's overlay is set→collect→clear (try/finally) so a sibling's overlay never leaks.
//
// THROW ISOLATION (§3.6): a SIBLING program whose LS throws (a broken sibling tsconfig) degrades to
// "no diagnostics + a note", so one bad sibling can't sink a cross-program rename/move. The PRIMARY
// is NEVER degraded — if its LS throws the gate has verified nothing, so the throw propagates to the
// caller's `failFromThrown('ts-ls')` (an honest "couldn't"), never a silent clean (a false success).

import type { RepoRelPath } from '../../core/brands.ts';
import { messageOfThrown } from '../../common/result/construct.ts';
import type { OverlayEntry } from './vfs/overlay.ts';
import type { SingleProgram } from './program/single.ts';
import { collectFromService, type TsDiagnostic } from './diagnostics.ts';

/** The host-side context the fan-out needs — the built programs + the host's path mappers. */
export interface GateHostCtx {
  primary: SingleProgram;
  /** Every built program, primary first (the host's `built()`). */
  programs: readonly SingleProgram[];
  relOf: (abs: string) => RepoRelPath;
  absOf: (rel: RepoRelPath) => string;
}

export interface GateScope {
  /** Files anchoring the affected-program set — a program is affected when it OWNS any of these
   *  (the edit's touched + removed paths). Primary is always included. */
  anchor: readonly RepoRelPath[];
  /** The check scope, passed identically to EVERY affected program (touched for rename; the whole
   *  tree for move/extract/codemod — `plan.checkPaths`, which already spans the test files). Each
   *  program's LS diagnoses only the files it actually contains, so the same list fans correctly. */
  check: readonly RepoRelPath[];
  /** Tombstoned (moved-away) paths for the overlay pass. */
  removed?: readonly RepoRelPath[];
}

/** The aggregated baseline + overlay diagnostics plus provenance: `programs` are the labels actually
 *  checked, `degraded` the sibling labels whose LS threw (skipped, with a reason) — both surfaced so
 *  the agent sees how many programs the verdict rests on (§3.6 / §6). */
export interface GateResult {
  baseline: TsDiagnostic[];
  overlay: TsDiagnostic[];
  programs: string[];
  degraded: string[];
}

/** A program OWNS a file when it contains it today OR its glob would after the edit (`mayContain`). */
function owns(program: SingleProgram, absPosix: string): boolean {
  return program.containsFile(absPosix) || program.mayContain(absPosix);
}

/** Programs (primary ALWAYS first) that own any anchor file. */
function affected(ctx: GateHostCtx, anchor: readonly RepoRelPath[]): SingleProgram[] {
  const anchorAbs = anchor.map((p) => ctx.absOf(p));
  const out: SingleProgram[] = [ctx.primary];
  for (const program of ctx.programs) {
    if (program === ctx.primary) continue;
    if (anchorAbs.some((a) => owns(program, a))) out.push(program);
  }
  return out;
}

/** Does `program` get `absPosix` in the overlay? It does if it OWNS the path; additionally the
 *  PRIMARY claims any path owned by NO program at all — a move/extract DEST in a dir outside every
 *  tsconfig glob (an unindexed `out/`/`scripts/` dir). Without this fallback the rewritten importer
 *  (owned by primary) would resolve the moved-to specifier against an un-overlaid dest → a spurious
 *  "Cannot find module" → a FALSE refusal of a sound move. This restores the prior primary-checks-
 *  everything behavior ONLY for genuinely-unowned paths, so siblings still never force-get a
 *  primary-owned file (the LOW symmetry fix holds) and an owned dest is still checked by its owner. */
function claimedBy(
  ctx: GateHostCtx,
  program: SingleProgram,
  programs: readonly SingleProgram[],
  absPosix: string,
): boolean {
  if (owns(program, absPosix)) return true;
  return program === ctx.primary && !programs.some((p) => owns(p, absPosix));
}

/** The overlay entries (and tombstones) THIS program claims — the symmetry filter (rule 2 above). */
function entriesFor(
  ctx: GateHostCtx,
  program: SingleProgram,
  programs: readonly SingleProgram[],
  entries: readonly OverlayEntry[],
): OverlayEntry[] {
  return entries.filter((e) => claimedBy(ctx, program, programs, e.abs));
}
function removedFor(
  ctx: GateHostCtx,
  program: SingleProgram,
  programs: readonly SingleProgram[],
  removed: readonly RepoRelPath[] | undefined,
): RepoRelPath[] | undefined {
  if (removed === undefined) return undefined;
  return removed.filter((r) => claimedBy(ctx, program, programs, ctx.absOf(r)));
}

/** Set this program's overlay, collect, ALWAYS clear (the overlay must never leak into a later read). */
function overlayCollect(
  ctx: GateHostCtx,
  program: SingleProgram,
  programs: readonly SingleProgram[],
  entries: readonly OverlayEntry[],
  removed: readonly RepoRelPath[] | undefined,
  checkAbs: readonly string[],
): TsDiagnostic[] {
  try {
    program.setOverlay(
      entriesFor(ctx, program, programs, entries),
      removedFor(ctx, program, programs, removed),
    );
    return collectFromService(program.service, ctx.relOf, checkAbs);
  } finally {
    program.clearOverlay();
  }
}

/** Disk diagnostics across every affected program (no overlay) — the post-apply check. `restrictTo`
 *  (program labels) PINS the set to the one the pre-apply baseline sampled: a move changes program
 *  membership (a moved-in file enters a sibling's glob), so a post-apply re-`affected()` would sample
 *  a program the baseline never did → its PRE-EXISTING errors mis-count as introduced. Omit
 *  `restrictTo` for the baseline itself. PRIMARY throwing propagates (→ rollback); a SIBLING throwing
 *  post-apply is skipped — SAFE because apply only got here by passing a CLEAN pre-apply OVERLAY gate
 *  over the identical post-edit bytes (this disk pass is a redundant re-verification of bytes already
 *  verified), and a broken sibling already surfaced a degraded note pre-apply (the same throw fires on
 *  both passes). So the skip cannot turn a real error into a false clean. (§3.6) */
export function diagnosticsAcross(
  ctx: GateHostCtx,
  scope: GateScope,
  restrictTo?: readonly string[],
): TsDiagnostic[] {
  const checkAbs = scope.check.map((p) => ctx.absOf(p));
  const programs =
    restrictTo === undefined
      ? affected(ctx, scope.anchor)
      : ctx.programs.filter((p) => restrictTo.includes(p.label));
  const out: TsDiagnostic[] = [];
  for (const program of programs) {
    if (program === ctx.primary) {
      out.push(...collectFromService(program.service, ctx.relOf, checkAbs)); // propagate → rollback
      continue;
    }
    try {
      out.push(...collectFromService(program.service, ctx.relOf, checkAbs));
    } catch {
      /* broken sibling post-apply: skip — the clean pre-apply overlay gate already verified these
         bytes; this disk pass is redundant re-verification (see the function note). */
    }
  }
  return out;
}

/** Baseline (disk) + overlay diagnostics across every affected program, sampled symmetrically.
 *  Each program is overlaid with ONLY the entries it owns and ALWAYS cleared (try/finally). A
 *  SIBLING whose LS throws is degraded to a note (it can't sink the gate); the PRIMARY's throw
 *  propagates (the gate verified nothing → an honest failure, never a silent clean). Returns the
 *  checked-program labels so the post-apply `diagnosticsAcross` can pin the SAME set. */
export function gateAcross(
  ctx: GateHostCtx,
  files: readonly { path: RepoRelPath; content: string }[],
  scope: GateScope,
): GateResult {
  const programs = affected(ctx, scope.anchor);
  const checkAbs = scope.check.map((p) => ctx.absOf(p));
  const entries: OverlayEntry[] = files.map((f) => ({
    abs: ctx.absOf(f.path),
    content: f.content,
  }));

  const baseline: TsDiagnostic[] = [];
  const overlay: TsDiagnostic[] = [];
  const checked: string[] = [];
  const degraded: string[] = [];
  for (const program of programs) {
    if (program === ctx.primary) {
      // NEVER degraded: a throw here means nothing was verified → propagate (honest ts-ls failure).
      baseline.push(...collectFromService(program.service, ctx.relOf, checkAbs));
      overlay.push(...overlayCollect(ctx, program, programs, entries, scope.removed, checkAbs));
      checked.push(program.label);
      continue;
    }
    try {
      // Collect BOTH passes before committing either (symmetry): if the overlay pass throws after a
      // clean baseline, neither is kept — the sibling degrades wholesale, never half-counted.
      const b = collectFromService(program.service, ctx.relOf, checkAbs);
      const o = overlayCollect(ctx, program, programs, entries, scope.removed, checkAbs);
      baseline.push(...b);
      overlay.push(...o);
      checked.push(program.label);
    } catch (thrown) {
      // Collapse whitespace: a multi-line LS-throw message would otherwise render as several
      // physical note lines (the dense renderer splits on \n), breaking one-fact-per-line.
      degraded.push(`${program.label} (${messageOfThrown(thrown).replace(/\s+/g, ' ').trim()})`);
    }
  }
  return { baseline, overlay, programs: checked, degraded };
}
