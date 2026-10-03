// Membership fidelity between the §2.8 overlay gate and the post-apply disk state (t-439159). The
// post-apply recheck diagnoses only the WRITTEN files, which is sound only while every written file
// sits, after the write, in exactly the programs the overlay gate put it in: equal bytes + equal
// membership + unchanged compilerOptions ⇒ the disk programs equal the overlay ones, so an unwritten
// file cannot carry an error the gate did not see. Two overlay behaviours break that equality — the
// `claimedBy` fallback force-adds an UNOWNED dest as a primary root, and a glob-owned but
// gitignored dest is overlaid although `loadFileList` excludes it on disk (t-433767) — and a
// written tsconfig/package.json/.gitignore changes options or file lists the overlay never modelled.
// Any of these → the caller widens the recheck to the gate's full scope.

import type { RepoRelPath } from '../../core/brands.ts';
import { affected, claimedBy, type GateHostCtx, type GateScope } from './program-gate.ts';
import { isTsconfigBasename } from './program/discover.ts';

/** Which gate programs (by label) the overlay put each written source path into, plus the written
 *  paths that restructure programs outright. Captured BEFORE `gateAcross`, so the `getProgram()`
 *  `owns` forces is the very build the gate's baseline then reuses. */
export interface GateClaims {
  readonly byPath: ReadonlyMap<RepoRelPath, ReadonlySet<string>>;
  readonly structural: readonly RepoRelPath[];
}

const PROGRAM_SOURCE = /\.(ts|tsx|js|jsx|mts|cts)$/;

/** Can a change to this path move a typecheck verdict? Program sources, JSON (resolveJsonModule,
 *  tsconfig, package.json) and `.gitignore` (it reshapes the program file list). */
export function affectsTypecheck(rel: string): boolean {
  return PROGRAM_SOURCE.test(rel) || rel.endsWith('.json') || basename(rel) === '.gitignore';
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

function restructures(rel: string): boolean {
  const base = basename(rel);
  return isTsconfigBasename(base) || base === 'package.json' || base === '.gitignore';
}

export function overlayClaims(
  ctx: GateHostCtx,
  scope: GateScope,
  written: readonly RepoRelPath[],
): GateClaims {
  const programs = affected(ctx, scope.anchor);
  const byPath = new Map<RepoRelPath, ReadonlySet<string>>();
  for (const rel of written) {
    if (!PROGRAM_SOURCE.test(rel)) continue;
    const abs = ctx.absOf(rel);
    byPath.set(
      rel,
      new Set(programs.filter((p) => claimedBy(ctx, p, programs, abs)).map((p) => p.label)),
    );
  }
  const structural = [...written, ...(scope.removed ?? [])].filter(restructures);
  return { byPath, structural };
}

/** Written paths whose post-write membership (`containsFile`, after reindex) differs from the
 *  overlay's within the checked programs `restrictTo`, plus every structural path. Empty ⇒ the
 *  narrow recheck is sound. */
export function claimDivergence(
  ctx: GateHostCtx,
  claims: GateClaims,
  restrictTo: readonly string[],
): RepoRelPath[] {
  const programs = ctx.programs.filter((p) => restrictTo.includes(p.label));
  const out: RepoRelPath[] = [...claims.structural];
  for (const [rel, claimed] of claims.byPath) {
    const abs = ctx.absOf(rel);
    const differs = programs.some((p) => claimed.has(p.label) !== p.containsFile(abs));
    if (differs) out.push(rel);
  }
  return out;
}
