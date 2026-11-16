// Which programs the §2.8 write gate samples, and which overlay entries each one gets — the two
// symmetry rules of program-gate.ts, plus the two facts they need beyond a program's own glob:
//   - a move DEST follows its SOURCE: a program that holds the source only transitively (an import
//     from a file it globs) reaches the dest through the rewritten import after the move, so it
//     gets the dest in the overlay too — else its rewritten importers read `Cannot find module`;
//   - an extends-only base config (no `files`/`include` in its chain → TS's default `**/*`, and the
//     `extends` target of another loaded config) is not a typecheck authority: its glob owns every
//     file, yet nothing typechecks the repo under it — its extenders do. Skipped, and disclosed.

import type { RepoRelPath } from '../../core/brands.ts';
import { toPosix } from '../../support/fs/canonicalize.ts';
import type { SingleProgram } from './program/single.ts';

export interface OwnershipCtx {
  primary: SingleProgram;
  programs: readonly SingleProgram[];
  absOf: (rel: RepoRelPath) => string;
}

/** One move of the edit (`RefactorPlan.moves`): a file, or a directory with everything under it. */
export interface GateMove {
  from: RepoRelPath;
  to: RepoRelPath;
  kind: 'file' | 'dir';
}

/** A program OWNS a file when it contains it today OR its glob would after the edit (`mayContain`). */
export function owns(program: SingleProgram, absPosix: string): boolean {
  return program.containsFile(absPosix) || program.mayContain(absPosix);
}

/** Non-primary programs whose config is an extends-only base of another loaded program: extended,
 *  default file set, and nothing runs it as a project — not named `tsconfig.json` (what `tsc` in its
 *  dir picks), not a `references` target (`tsc -b`), not named by its package's scripts. Any one of
 *  those makes a default-glob config a real owner whose options the gate must apply (§5-L2). The
 *  primary is never one: its throw is never degraded and it claims unowned paths (t-041300). */
export function extendsOnlyBases(ctx: OwnershipCtx): SingleProgram[] {
  const shapes = ctx.programs.map((p) => p.configShape());
  const extended = new Set(shapes.flatMap((s) => s.extends));
  const referenced = new Set(shapes.flatMap((s) => s.references));
  return ctx.programs.filter((p) => {
    if (p === ctx.primary || p.configPath === undefined) return false;
    const config = toPosix(p.configPath);
    const shape = p.configShape();
    return (
      shape.defaultFileSet &&
      !shape.runByScript &&
      extended.has(config) &&
      !referenced.has(config) &&
      !config.endsWith('/tsconfig.json')
    );
  });
}

/** Programs (primary ALWAYS first) that own any anchor file, extends-only bases excluded. */
export function affected(ctx: OwnershipCtx, anchor: readonly RepoRelPath[]): SingleProgram[] {
  const anchorAbs = anchor.map((p) => ctx.absOf(p));
  const bases = new Set(extendsOnlyBases(ctx));
  const out: SingleProgram[] = [ctx.primary];
  for (const program of ctx.programs) {
    if (program === ctx.primary || bases.has(program)) continue;
    if (anchorAbs.some((a) => owns(program, a))) out.push(program);
  }
  return out;
}

/** The extends-only bases `affected` left out although they own an anchor file — what the gate
 *  discloses as skipped. */
export function skippedBases(ctx: OwnershipCtx, anchor: readonly RepoRelPath[]): SingleProgram[] {
  const anchorAbs = anchor.map((p) => ctx.absOf(p));
  return extendsOnlyBases(ctx).filter((p) => anchorAbs.some((a) => owns(p, a)));
}

/** The source path a dest path was moved from, when `absPosix` is (under) a move's dest. */
export function sourceOf(
  ctx: OwnershipCtx,
  moves: readonly GateMove[] | undefined,
  absPosix: string,
): string | undefined {
  for (const m of moves ?? []) {
    const to = ctx.absOf(m.to);
    if (absPosix === to) return ctx.absOf(m.from);
    if (m.kind === 'dir' && absPosix.startsWith(`${to}/`)) {
      return ctx.absOf(m.from) + absPosix.slice(to.length);
    }
  }
  return undefined;
}

/** How `program` gets `absPosix` in the overlay: as a ROOT when its glob tracks or would track the
 *  path, REACHED (content shadowed, not rooted) when it holds the path or the path's move source only
 *  through an import — the role the file plays in the program before and after the edit, so baseline
 *  and overlay agree. Additionally the PRIMARY roots any path owned by NO checked program — a
 *  move/extract DEST in a dir outside every tsconfig glob (an unindexed `out/`/`scripts/` dir).
 *  Without this fallback the rewritten importer (owned by primary) would resolve the moved-to
 *  specifier against an un-overlaid dest → a spurious "Cannot find module" → a FALSE refusal of a
 *  sound move. `undefined`: the program does not get the path. */
export function claimOf(
  ctx: OwnershipCtx,
  program: SingleProgram,
  programs: readonly SingleProgram[],
  absPosix: string,
  moves?: readonly GateMove[],
): 'root' | 'reached' | undefined {
  if (program.isTracked(absPosix) || program.mayContain(absPosix)) return 'root';
  if (program.containsFile(absPosix)) return 'reached';
  const source = sourceOf(ctx, moves, absPosix);
  if (source !== undefined && program.containsFile(source)) return 'reached';
  if (program === ctx.primary && !programs.some((p) => owns(p, absPosix))) return 'root';
  return undefined;
}

export function claimedBy(
  ctx: OwnershipCtx,
  program: SingleProgram,
  programs: readonly SingleProgram[],
  absPosix: string,
  moves?: readonly GateMove[],
): boolean {
  return claimOf(ctx, program, programs, absPosix, moves) !== undefined;
}
