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
// DELIBERATELY NOT the same fan policy as `../cross-program.ts` (`findReferencesAcross`), which runs
// the same three steps — `ensureProgramFor` → `programsContaining` → fall back to the primary — but
// KEEPS the no-config fallback. The divergence is principled, not an oversight: a REFERENCE set is
// barely `compilerOptions`-sensitive, so the fallback is a usable reference oracle, while a TYPE
// verdict under its DEFAULT options is a verdict the project never yields. Do not harmonise these two
// functions in either direction without settling that question first.
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
import type { ScanCoverage, ScanProgramCoverage, SkippedProgram } from './scan-coverage-view.ts';

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
 *  actually resolves its aliases.
 *
 *  SESSION ORDER (§16 cold==warm, and why it holds): `programsContaining` is `built()` first, then any
 *  file-driven / `programs:`-lever programs this session happened to load — so a warm session's fan can
 *  be a SUPERSET of a cold one's. That is honest in both directions rather than a drift, because the
 *  extra programs come from configs that were in `undiscoveredProgramLabels()` before they loaded and
 *  are subtracted from it after: the cold run reports `complete:false` naming exactly those configs,
 *  the warm run scans them and reports the larger set. Additive only — `built()` leads, so a later
 *  program can never steal a file claim and never re-attribute a verdict. */
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
  const skipped: SkippedProgram[] = [];
  const claimed = new Set<string>();
  const eligible = new Set<string>();
  const queues: ClaimedFile[][] = [];

  for (const program of fanout.fan) {
    // §19 loop boundary #1 — the PROGRAM loop. `getProgram()` warms a checker, so on an N-program
    // monorepo the fan can outlive the whole budget in warms alone; without this poll the first
    // deadline check would come after every program was built. A fan cut short is a DIFFERENT fact
    // from a walk cut short (the programs were never consulted at all), so it is recorded as such.
    if (options.deadline?.expired() === true) {
      skipped.push({ label: program.label, reason: 'deadline' });
      continue;
    }
    const tsProgram = program.getProgram();
    if (tsProgram === undefined) {
      skipped.push({ label: program.label, reason: 'program-unavailable' });
      continue;
    }
    const ctx = spec.resolve(tsProgram, tsProgram.getTypeChecker());
    if (ctx === undefined) {
      // The target does not resolve to a CHECKABLE type under this program's own options (vacuous /
      // non-union there). Skipping is right — judging its files against a type it does not have would
      // flood or lie. Claiming completeness afterwards would not: this is the t-162650 shape coming
      // back through another door, so the skip is disclosed and demotes the answer.
      skipped.push({ label: program.label, reason: 'no-checkable-type' });
      continue;
    }
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
    per.push({
      label: program.label,
      files: files.length,
      walked: 0,
      examined: 0,
      candidates: 0,
    });
    queues.push(files);
  }
  // `undefined` means "no program could resolve T" — a claim about the TARGET. When the deadline is
  // what emptied the fan, that claim is unsupported: nothing was consulted, so nothing is known about
  // T. Fall through instead and let the op answer `partial{timeout}` over an empty coverage. Reporting
  // "T resolves to no checkable type anywhere" because we ran out of time is the §3.6 lie of
  // converting a "couldn't" into a finding.
  const deadlineEmptiedFan = skipped.some((entry) => entry.reason === 'deadline');
  if (resolved.length === 0 && !deadlineEmptiedFan) return undefined;

  const sites: S[] = [];
  let examined = 0;
  let walkedFiles = 0;
  let deadlineHit = deadlineEmptiedFan;
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
    tally.walked++;
    walkedFiles++;
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

  // BLOCK: the dedup set here is `eligible` (PRE path-filter), never `claimed`. A fallback file is
  // fallback-only iff no RESOLVED fan program CONTAINS it — a file a real program covers but the
  // caller's own glob excluded is not "covered by no tsconfig", and saying so would blame a missing
  // config for the caller's scope and offer "add a tsconfig" as an inert remedy (t-259465).
  const fallbackOnlyFiles =
    fanout.excludedFallback !== undefined
      ? countUnclaimed(host, fanout.excludedFallback, eligible)
      : 0;
  return {
    sites,
    coverage: {
      programs: per,
      files: claimed.size,
      walkedFiles,
      eligibleFiles: eligible.size,
      examined,
      limit: options.limit,
      candidates: per.reduce((n, p) => n + p.candidates, 0),
      ...(skipped.length > 0 ? { skipped } : {}),
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

/** A declaration file by PATH — the `fileNames()` counterpart of `isDeclarationFile`, which needs a
 *  parsed SourceFile the fallback program must not be built to provide. All three modern extensions,
 *  so the unclaimed count cannot be inflated by `.d.mts`/`.d.cts` files that carry no expressions and
 *  would never have been scanned anyway (a floor must not over-state either). */
const DECL_EXT = /\.d\.(ts|mts|cts)$/;

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
    if (abs.includes('/node_modules/') || DECL_EXT.test(abs)) continue;
    const rel = host.relOf(abs);
    if (path.isAbsolute(String(rel))) continue;
    if (!claimed.has(String(rel))) n++;
  }
  return n;
}
