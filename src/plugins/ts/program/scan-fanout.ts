// Cross-program fan-out for the TYPE-ANCHORED SCANNING reads — `construction_sites` and
// `discrimination_sites` (t-162650). Both answer a blast-radius question ("what BUILDS a T?",
// "which switch discriminates on T?") by walking a program's source files and running one
// expensive checker call per candidate node. Over ONE program they return a confident `0` for a
// site that lives in a SIBLING program — the completeness lie `find_usages` already avoids by
// fanning (`../cross-program.ts`), from the ops whose stated purpose IS the blast radius.
//
// A verdict is INVALID ACROSS PROGRAMS (two programs are two checkers with two type identities),
// so the fan never shares one target type: it re-resolves the target IN EACH program and checks
// that program's own files against that program's own type. Each file is CLAIMED by the first
// program in fan order that owns it (dedup by `RepoRelPath`), so the expensive check runs once per
// file and the compute surface is the UNION of the programs' file sets, not their sum.
//
// The no-config FALLBACK primary is excluded as a scan authority whenever a real-config program
// contains the target declaration (t-593802): its whole-repo glob under DEFAULT options absorbs
// `declare global`/`declare module` strays and resolves no `paths`, so a verdict it produces about
// a member file is one the project's own tsconfig never yields. The files it ALONE covers are then
// unscanned — reported as a floor, never scanned against an unsound type.
//
// Bounded (§1/§19): ONE global `examined` budget across the whole fan, so N programs never
// multiply the compute bound; spent ROUND-ROBIN over the fan's files so a large primary cannot
// starve a sibling to zero; plus a cooperative `Deadline` poll at the file boundary.

import ts from 'typescript';
import * as path from 'node:path';
import type { RepoRelPath } from '../../../core/brands.ts';
import type { Deadline } from '../../../common/async/deadline.ts';
import { pathScopePredicate } from '../path-scope.ts';
import type { TsProjectHost } from '../ls-host.ts';
import type { TsProgram } from './queryable-program.ts';
import { NO_CONFIG_LABEL } from './discover.ts';

/** What one fanned program contributed. `examined < candidates` means its own candidates were left
 *  unchecked because the shared budget ran out — a LOADED program we did not finish, which is a
 *  different fact (and a different remedy) from a config never loaded at all. */
export interface ScanProgramCoverage {
  label: string;
  files: number;
  examined: number;
  candidates: number;
}

/** The positive scope of a fanned scan — WHAT was walked, per program, plus every reason the walk
 *  may be short of the question. Machine-readable so the op renders a verdict instead of prose
 *  (§3.4): `sites: 0` is only an assignability/identity verdict when this says the scan was
 *  complete. */
export interface ScanCoverage {
  /** Per-program, in fan order (the target's type authority first). */
  programs: ScanProgramCoverage[];
  /** Union totals over the claimed file set. */
  files: number;
  /** Union of files the fan COULD have walked, before `pathInclude`/`pathExclude`. `files === 0`
   *  with `eligibleFiles > 0` proves the path filter — not the program set — emptied the scan, which
   *  is the difference between a remedy that works and one that cannot (§3.6). */
  eligibleFiles: number;
  examined: number;
  candidates: number;
  /** Files covered ONLY by the excluded no-config fallback primary — unscanned by design. */
  fallbackOnlyFiles?: number;
  /** No real-config program contains the target: the scan ran on the no-config fallback, whose
   *  DEFAULT options resolve no `paths` and absorb whole-repo strays. */
  fallbackOnly?: true;
  /** The cooperative deadline expired mid-scan (§19) — the sites found are real, the scan is not
   *  finished. */
  deadlineHit?: true;
}

/** The scan contract each op supplies. `C` is the op's per-program resolved target (its type plus
 *  whatever it precomputes from it), `P` a prepared candidate, `S` one emitted site.
 *
 *  `prepare` and `evaluate` are split on COST, not on convenience: `prepare` is the cheap syntactic
 *  half and runs on every node (its hits are what `candidates` counts, so the count stays honest
 *  past the budget), while `evaluate` is the checker work the budget actually bounds. The prepared
 *  payload carries over, so a candidate is never analysed twice. */
export interface FanoutScanSpec<C, P, S> {
  /** Resolve the target IN this program. `undefined` skips the program — the target does not
   *  resolve to a type there, so nothing it contains could be checked against one. */
  resolve(program: ts.Program, checker: ts.TypeChecker): C | undefined;
  /** Cheap syntactic candidate test + payload. `undefined` = not a candidate. */
  prepare(node: ts.Node, sourceFile: ts.SourceFile): P | undefined;
  /** The EXPENSIVE per-candidate check — one `examined` unit. `undefined` = not a site. */
  evaluate(prepared: P, resolved: C, sourceFile: ts.SourceFile, rel: RepoRelPath): S | undefined;
}

export interface FanoutScanOptions {
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** The shared cap on expensive checks across the WHOLE fan. */
  limit: number;
  deadline?: Deadline | undefined;
}

/** The programs a type-anchored scan of `declAbs` may honestly walk, type-authority first. */
export interface ScanFanout {
  fan: readonly TsProgram[];
  fallbackOnly: boolean;
  /** The excluded no-config fallback, when a real-config program took over as authority. */
  excludedFallback: TsProgram | undefined;
}

/** Pick the fan: every program CONTAINING the target declaration, the type authority first, with
 *  the no-config fallback primary demoted out of the set unless nothing else contains the target.
 *  `ensureProgramFor` first — read-path parity with `findReferencesAcross(loadNearest:true)`, so a
 *  decl whose nearest enclosing tsconfig is a nested config is scanned under the config that
 *  actually resolves its aliases. */
export function selectScanFanout(host: TsProjectHost, declAbs: string): ScanFanout {
  host.ensureProgramFor(declAbs);
  const authority = host.typeAuthorityFor(declAbs);
  const containing = host.programsContaining(declAbs);
  const real = containing.filter((p) => p.label !== NO_CONFIG_LABEL);
  const excludedFallback = containing.find((p) => p.label === NO_CONFIG_LABEL);
  if (real.length === 0) {
    // Nothing but the fallback covers the target — scan it (an answer beats a refusal) and say so.
    return { fan: [authority], fallbackOnly: true, excludedFallback: undefined };
  }
  const head = real.includes(authority) ? [authority] : [];
  return {
    fan: [...head, ...real.filter((p) => p !== authority)],
    fallbackOnly: false,
    excludedFallback,
  };
}

/** One scannable file, claimed by the program whose checker will judge it. */
interface ClaimedFile {
  sourceFile: ts.SourceFile;
  rel: RepoRelPath;
  slot: number;
}

/** Walk `fanout`'s programs under one shared budget and return the sites plus the positive scope.
 *  `undefined` when NO program in the fan resolves the target to a type — the caller reports its
 *  own "couldn't resolve" failure rather than an empty answer (a laundered `couldn't` shaped like a
 *  proven absence is the §3.6 lie). */
export function runFanoutScan<C, P, S>(
  host: TsProjectHost,
  fanout: ScanFanout,
  options: FanoutScanOptions,
  spec: FanoutScanSpec<C, P, S>,
): { sites: S[]; coverage: ScanCoverage } | undefined {
  const inScope = pathScopePredicate(options.pathInclude, options.pathExclude);
  const resolved: C[] = [];
  const per: ScanProgramCoverage[] = [];
  const claimed = new Set<string>();
  const eligible = new Set<string>();
  const queues: ClaimedFile[][] = [];

  for (const program of fanout.fan) {
    const tsProgram = program.getProgram();
    if (tsProgram === undefined) continue;
    const ctx = spec.resolve(tsProgram, tsProgram.getTypeChecker());
    if (ctx === undefined) continue;
    const slot = resolved.length;
    resolved.push(ctx);
    const files: ClaimedFile[] = [];
    for (const sourceFile of tsProgram.getSourceFiles()) {
      const rel = scannableRel(host, sourceFile);
      if (rel === undefined) continue;
      eligible.add(String(rel));
      if (!inScope(rel)) continue;
      // First program in fan order wins the file. Fan order is type-authority-first, so a file in
      // two real-config programs is judged by the authority for the TARGET — and a sibling-only
      // file by its own program. Two real configs CAN judge one file differently (divergent
      // `exactOptionalPropertyTypes`/`paths`); the tie is broken deterministically, never merged.
      if (claimed.has(String(rel))) continue;
      claimed.add(String(rel));
      files.push({ sourceFile, rel, slot });
    }
    per.push({ label: program.label, files: files.length, examined: 0, candidates: 0 });
    queues.push(files);
  }
  if (resolved.length === 0) return undefined;

  const sites: S[] = [];
  let examined = 0;
  let deadlineHit = false;
  for (const file of roundRobin(queues)) {
    // §19 loop boundary: the accumulated sites are REAL data, so an overrun degrades to a partial
    // scan (disclosed), never a spin and never a `timeout` that throws the found sites away.
    if (options.deadline?.expired() === true) {
      deadlineHit = true;
      break;
    }
    const tally = per[file.slot];
    const ctx = resolved[file.slot];
    if (tally === undefined || ctx === undefined) continue;
    const visit = (node: ts.Node): void => {
      const prepared = spec.prepare(node, file.sourceFile);
      if (prepared !== undefined) {
        tally.candidates++;
        // Count past the budget (cheap) so the truncation is honest, check only within it.
        if (examined < options.limit) {
          examined++;
          tally.examined++;
          const site = spec.evaluate(prepared, ctx, file.sourceFile, file.rel);
          if (site !== undefined) sites.push(site);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file.sourceFile);
  }

  const fallbackOnlyFiles =
    fanout.excludedFallback !== undefined
      ? countUnclaimed(host, fanout.excludedFallback, claimed)
      : 0;
  return {
    sites,
    coverage: {
      programs: per,
      files: claimed.size,
      eligibleFiles: eligible.size,
      examined,
      candidates: per.reduce((n, p) => n + p.candidates, 0),
      ...(fallbackOnlyFiles > 0 ? { fallbackOnlyFiles } : {}),
      ...(fanout.fallbackOnly ? { fallbackOnly: true as const } : {}),
      ...(deadlineHit ? { deadlineHit: true as const } : {}),
    },
  };
}

/** Interleave the per-program file queues so ONE shared budget is spread across the fan. Program
 *  order still decides within a round (the type authority leads), but a 3000-candidate primary can
 *  no longer spend the whole budget before a sibling's first file is reached — a starved-to-zero
 *  sibling is the shape that made the single-program `0` look like a verdict. */
function* roundRobin<T>(queues: readonly (readonly T[])[]): Generator<T> {
  const longest = queues.reduce((n, q) => Math.max(n, q.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const queue of queues) {
      const item = queue[i];
      if (item !== undefined) yield item;
    }
  }
}

/** A file this scan may walk, as a repo-relative path — `undefined` for anything it must skip:
 *  a dependency, a declaration file (no expressions to check), or a path-mapped spillover OUTSIDE
 *  the root (`relOf` returns an absolute path there — never ours to scan). */
function scannableRel(host: TsProjectHost, sourceFile: ts.SourceFile): RepoRelPath | undefined {
  if (sourceFile.fileName.includes('/node_modules/') || sourceFile.isDeclarationFile) {
    return undefined;
  }
  const rel = host.relOf(sourceFile.fileName);
  return path.isAbsolute(String(rel)) ? undefined : rel;
}

/** How many of the excluded fallback primary's files no fanned program claimed — the files whose
 *  ONLY cover is a program we may not trust for a type verdict, so they are genuinely unscanned.
 *  One pass over an already-globbed array (no I/O, no build). */
function countUnclaimed(
  host: TsProjectHost,
  fallback: TsProgram,
  claimed: ReadonlySet<string>,
): number {
  let n = 0;
  for (const abs of fallback.fileNames()) {
    if (abs.includes('/node_modules/') || abs.endsWith('.d.ts')) continue;
    const rel = host.relOf(abs);
    if (path.isAbsolute(String(rel))) continue;
    if (!claimed.has(String(rel))) n++;
  }
  return n;
}
