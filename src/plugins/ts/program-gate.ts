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
import ts from 'typescript';
import { collectFromService, type TsDiagnostic } from './diagnostics.ts';
import type { GateCache } from './program-gate-cache.ts';
import {
  builderEligible,
  overlayKeyOf,
  scopeWantsBuilder,
  type GateBuilders,
} from './program-gate-builder.ts';

/** The host-side context the fan-out needs — the built programs + the host's path mappers. */
export interface GateHostCtx {
  primary: SingleProgram;
  /** Every built program, primary first (the host's `built()`). */
  programs: readonly SingleProgram[];
  relOf: (abs: string) => RepoRelPath;
  absOf: (rel: RepoRelPath) => string;
  /** Host-lifetime gate-result memo (program-gate-cache.ts); absent → every gate is computed. */
  cache?: GateCache;
  /** Host-lifetime diagnostics builders (program-gate-builder.ts); absent → every pass is a full
   *  LS pass. */
  builders?: GateBuilders;
  /** The host's shared cancellation predicate — the builder calls take a token, not the LS's. */
  cancel?: () => boolean;
}

/** The edit a post-apply recheck follows — the bytes just written and the paths removed. */
export interface WrittenEdit {
  files: readonly { path: RepoRelPath; content: string }[];
  removed: readonly RepoRelPath[];
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

/** The project host's write-gate surface (implemented in ls-host.ts over its built programs). */
export interface GateHost {
  /** §2.8 write gate, fanned across every program the edit touches (Task G for WRITES): the
   *  overlay typecheck on EACH affected program + the disk baseline over the same set, so a
   *  sibling-program dangle is caught. Builds the sibling programs (a write must verify them). */
  gateAcross(
    files: readonly { path: RepoRelPath; content: string }[],
    scope: GateScope,
  ): GateResult;
  /** Disk diagnostics across every affected program — the post-apply half of the fan-out gate.
   *  `restrictTo` pins the program set to the pre-apply baseline's (the `gateAcross` `programs`). */
  diagnosticsAcross(
    scope: GateScope,
    restrictTo?: readonly string[],
    written?: WrittenEdit,
  ): TsDiagnostic[];
  gateHostCtx(): GateHostCtx;
}

/** A program OWNS a file when it contains it today OR its glob would after the edit (`mayContain`). */
function owns(program: SingleProgram, absPosix: string): boolean {
  return program.containsFile(absPosix) || program.mayContain(absPosix);
}

/** Programs (primary ALWAYS first) that own any anchor file. */
export function affected(ctx: GateHostCtx, anchor: readonly RepoRelPath[]): SingleProgram[] {
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
export function claimedBy(
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
  collect: () => TsDiagnostic[],
): TsDiagnostic[] {
  try {
    program.setOverlay(
      entriesFor(ctx, program, programs, entries),
      removedFor(ctx, program, programs, removed),
    );
    return collect();
  } finally {
    program.clearOverlay();
  }
}

/** The builders when this program may use them: present, no overlay already applied (the "disk"
 *  pass would not be the disk), compilerOptions the incremental model is sound under, and a check
 *  scope wide enough to pay for a pass — or a post-apply recheck of bytes whose gate ran on them,
 *  which advances the chain the next gate's baseline starts from. */
function buildersFor(
  ctx: GateHostCtx,
  program: SingleProgram,
  checkAbs: readonly string[],
  writtenKey?: string,
): GateBuilders | undefined {
  const builders = ctx.builders;
  if (builders === undefined || program.overlayActive()) return undefined;
  const options = program.getProgram()?.getCompilerOptions();
  if (options === undefined || !builderEligible(options)) return undefined;
  const wide = scopeWantsBuilder(checkAbs.length, program.fileNames().length);
  const follows = writtenKey !== undefined && builders.follows(program, writtenKey);
  return wide || follows ? builders : undefined;
}

function tokenOf(ctx: GateHostCtx): ts.CancellationToken {
  const cancel = ctx.cancel ?? (() => false);
  return {
    isCancellationRequested: cancel,
    throwIfCancellationRequested: () => {
      if (cancel()) throw new ts.OperationCanceledException();
    },
  };
}

/** Disk diagnostics across every affected program (no overlay) — the post-apply recheck. `restrictTo`
 *  (program labels) PINS the set to the one the pre-apply baseline sampled: a move changes program
 *  membership (a moved-in file enters a sibling's glob), so a post-apply re-`affected()` would sample
 *  a program the baseline never did → its PRE-EXISTING errors mis-count as introduced. Omit
 *  `restrictTo` for the baseline itself. PRIMARY throwing propagates (the caller reports the recheck
 *  as incomplete); a SIBLING throwing post-apply is skipped — SAFE because apply only got here by
 *  passing a CLEAN pre-apply OVERLAY gate over the identical post-edit bytes, and a broken sibling
 *  already surfaced a degraded note pre-apply (the same throw fires on both passes). (§3.6) */
export function diagnosticsAcross(
  ctx: GateHostCtx,
  scope: GateScope,
  restrictTo?: readonly string[],
  written?: WrittenEdit,
): TsDiagnostic[] {
  const checkAbs = scope.check.map((p) => ctx.absOf(p));
  const programs =
    restrictTo === undefined
      ? affected(ctx, scope.anchor)
      : ctx.programs.filter((p) => restrictTo.includes(p.label));
  const writtenKey =
    written !== undefined
      ? overlayKeyOf(
          written.files.map((f) => ({ abs: ctx.absOf(f.path), content: f.content })),
          written.removed.map((r) => ctx.absOf(r)),
        )
      : undefined;
  const token = tokenOf(ctx);
  const collect = (program: SingleProgram): TsDiagnostic[] => {
    const builders = buildersFor(ctx, program, checkAbs, writtenKey);
    return builders !== undefined
      ? builders.disk(program, ctx.relOf, checkAbs, token, writtenKey)
      : collectFromService(program.service, ctx.relOf, checkAbs);
  };
  const out: TsDiagnostic[] = [];
  for (const program of programs) {
    if (program === ctx.primary) {
      out.push(...collect(program)); // propagate → rollback
      continue;
    }
    try {
      out.push(...collect(program));
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
  // An overlay already applied means the "baseline" below is not the disk → never cache it.
  const cache =
    ctx.cache !== undefined && !programs.some((p) => p.overlayActive()) ? ctx.cache : undefined;
  const key =
    cache !== undefined
      ? JSON.stringify([
          programs.map((p) => [cache.idOf(p), p.diskVersion()]),
          entries.map((e) => [e.abs, e.content]),
          scope.removed ?? null,
          checkAbs,
        ])
      : undefined;
  const hit = key !== undefined ? cache?.result(key, programs) : undefined;
  if (hit !== undefined) return hit;

  const token = tokenOf(ctx);
  const overlayKey = overlayKeyOf(
    entries,
    (scope.removed ?? []).map((r) => ctx.absOf(r)),
  );
  // Both passes of one program go through the same mechanism, so baseline and overlay are never
  // compared across two sources of truth.
  const sample = (program: SingleProgram) => {
    const builders = buildersFor(ctx, program, checkAbs);
    if (builders === undefined) {
      const b = collectFromService(program.service, ctx.relOf, checkAbs);
      const o = overlayCollect(ctx, program, programs, entries, scope.removed, () =>
        collectFromService(program.service, ctx.relOf, checkAbs),
      );
      return { b, o };
    }
    const b = builders.disk(program, ctx.relOf, checkAbs, token);
    const o = overlayCollect(ctx, program, programs, entries, scope.removed, () =>
      builders.overlay(program, ctx.relOf, checkAbs, token, overlayKey),
    );
    return { b, o };
  };

  const baseline: TsDiagnostic[] = [];
  const overlay: TsDiagnostic[] = [];
  const checked: string[] = [];
  const degraded: string[] = [];
  for (const program of programs) {
    if (program === ctx.primary) {
      // NEVER degraded: a throw here means nothing was verified → propagate (honest ts-ls failure).
      const { b, o } = sample(program);
      baseline.push(...b);
      overlay.push(...o);
      checked.push(program.label);
      continue;
    }
    try {
      // Collect BOTH passes before committing either (symmetry): if the overlay pass throws after a
      // clean baseline, neither is kept — the sibling degrades wholesale, never half-counted.
      const { b, o } = sample(program);
      baseline.push(...b);
      overlay.push(...o);
      checked.push(program.label);
    } catch (thrown) {
      // Collapse whitespace: a multi-line LS-throw message would otherwise render as several
      // physical note lines (the dense renderer splits on \n), breaking one-fact-per-line.
      degraded.push(`${program.label} (${messageOfThrown(thrown).replace(/\s+/g, ' ').trim()})`);
    }
  }
  const result = { baseline, overlay, programs: checked, degraded };
  // A degraded sibling may be transient (a deadline cancel inside it is caught as degraded).
  if (key !== undefined && degraded.length === 0) cache?.storeResult(key, programs, result);
  return result;
}
