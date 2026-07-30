// `construction_sites` machinery (§5-L2): given a TYPE T, the object-literal expressions the
// live checker deems assignable to T — factory returns, array elements, variable initializers,
// call arguments, fixtures — each proof-carrying (the literal span) with its enclosing
// declaration and an honest confidence. The type-aware complement to `find_usages`: "what
// builds a T?", which grep cannot answer. Semantic answers come from the live LS — the only
// oracle (§3.1).
//
// Bounded by DESIGN (§19 "scope inputs"): the EXPENSIVE work is one `isTypeAssignableTo` per
// object literal, so the cap bounds the NUMBER of assignability checks; past it, literals are
// still COUNTED (cheap) so the truncation is honest `{examined, candidates}`, never a silent
// undercount (§3.4). The syntactic AST walk scaling with repo size is the same exposure
// `find_unused_exports` carries; the hard wall-time guarantee is the §19 engine kill-on-deadline
// backstop (process mode), shared by every sync TS op, not this op's to invent.
//
// RECALL BOUNDARY (stated, never silent — §3.6): assignability is checked over each literal's
// FRESH type, so it is excess-property-checked exactly as a direct `const _: T = <literal>`
// would be. A literal that loses freshness through an intermediate binding before flowing to T
// — `const base = { …, extra }; useUser(base)` — is therefore NOT reported (its initializer is
// fresh and excess-fails). That is the v1 scope ("object literals + initializers to start").

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Deadline } from '../../common/async/deadline.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import { encloserView, moduleEncloser, type EncloserView } from './encloser-view.ts';
import { classifyConstructionSite } from './construction-confidence.ts';
import { enclosingConstruction } from './construction-encloser.ts';
import {
  describeTarget,
  isVacuousTarget,
  isGenericTarget,
  valueTargetNote,
  vacuousNote,
} from './construction-target.ts';
import { runFanoutScan, selectScanFanout, type ScanCoverage } from './program/scan-fanout.ts';
import type { TsProjectHost } from './ls-host.ts';

export type ConstructionSite = {
  /** The object-literal span — proof of WHERE the construction is (§3.1). */
  span: Span;
  confidence: Confidence;
  /** Why a non-`certain` confidence (vacuous `any` / generic boundary). */
  note?: string;
  encloser: EncloserView;
};

export type ConstructionTarget = {
  name: string;
  kind: string;
  /** The target type's name-token span — proof of WHAT T is. */
  span: Span;
};

export type ConstructionSitesView = {
  target: ConstructionTarget;
  sites: ConstructionSite[];
  /** Object literals examined (assignability checked) — the union across the fanned programs. */
  scannedLiterals: number;
  /** In-scope source files walked — the union across the fanned programs. */
  scannedFiles: number;
  /** The positive per-program scope + every reason the scan may fall short (§3.4). ABSENT when no
   *  scan was attempted (a target guard fired), so the op never dresses an unqueryable target as a
   *  0-site scan. */
  coverage?: ScanCoverage;
  /** Present when the candidate cap was hit: `examined` of `candidates` total. */
  truncated?: { examined: number; candidates: number };
  /** Honest caveats not tied to a site (target-level: value-resolved / vacuous). */
  notes?: string[];
};

export interface ConstructionSitesOptions {
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Hard cap on object literals examined — the compute bound (§1/§19). */
  limit?: number | undefined;
  /** The op's cooperative wall-clock budget — polled at the file boundary so a whole-repo fan
   *  degrades to a disclosed PARTIAL scan instead of spinning (§19). */
  deadline?: Deadline | undefined;
}

/** Default scan cap: bounds the assignability checks on a whole-repo call (each is one
 *  `isTypeAssignableTo`) — ONE budget for the whole cross-program fan, so N programs never multiply
 *  it. Narrow further with pathInclude. Exported so the op's floor note states the SAME number the
 *  scan actually spent (a hard-coded copy there could drift from the budget it explains).
 *
 *  Sized so the DEFAULT call over a mid-size repo finishes rather than floors. A budget that always
 *  truncates makes the op's answer permanently a lower bound, which is honest but useless for the
 *  blast-radius question it exists to answer — and the fan doubled the candidate pool that has to
 *  fit (measured on codemaster: 7010 object literals across its two programs, ~5 s for a complete
 *  scan). The wall-clock guarantee is no longer this number's job: the scan polls the op's
 *  `Deadline` at the file boundary and degrades to a disclosed PARTIAL (§19), and the §9 fan-out
 *  guard refuses the warm outright where an oversized in-process repo could OOM. */
export const DEFAULT_SCAN_CAP = 10_000;

export function findConstructionSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: ConstructionSitesOptions,
): ConstructionSitesView | string {
  // Assignability is invalid ACROSS programs, so the fan never shares one target type: it
  // re-resolves T in EACH fanned program and checks that program's own files against that
  // program's own type (`scan-fanout.ts`). The type authority answers the TARGET-level questions
  // (its span, whether it is vacuous/generic) because a target guard must not depend on which
  // sibling happened to load — in a no-root repo the fallback primary's whole-repo glob would
  // pollute the type it reports (t-593802).
  const fanout = selectScanFanout(host, abs);
  const authority = fanout.fan[0]?.getProgram();
  if (authority === undefined) return 'the TS program is unavailable';
  const checker = authority.getTypeChecker();
  const targetFile = authority.getSourceFile(abs);
  if (targetFile === undefined) return 'the target file is not in the TS project';
  const node = nodeAt(targetFile, offset);
  if (node === undefined) return 'no node at the resolved position';
  const targetType = typeAtNode(checker, node);
  if (targetType === undefined) return 'no type at the resolved position';

  const targetSym = checker.getSymbolAtLocation(node);
  const target = describeTarget(host, targetFile, node, targetSym);

  // A TOP/OPEN target (`any`/`unknown`/`object`/`{}`/marker interface/`Record<string,unknown>`,
  // or a union with such an arm) accepts EVERY object literal — reporting them all as `certain`
  // builds of T would be the cardinal false-certain lie (bug-reviewer §1). Short-circuit to a 0
  // answer with a target-level note: this is not a meaningful "what builds T" query.
  if (isVacuousTarget(checker, targetType)) {
    // A value target whose INFERRED type is vacuous (`const x = {}`) still owes the "resolves to a
    // VALUE" caveat — it never reaches the post-scan note path below (§3.6, full disclosure).
    const vacuousNotes =
      target.kind === 'value'
        ? [valueTargetNote(target), vacuousNote(target)]
        : [vacuousNote(target)];
    return { target, sites: [], scannedLiterals: 0, scannedFiles: 0, notes: vacuousNotes };
  }

  const scan = runFanoutScan(
    host,
    fanout,
    { ...options, limit: options.limit ?? DEFAULT_SCAN_CAP },
    {
      // Per-program target resolve: T's identity is that program's, and so is the assignability
      // verdict. A program where T reads VACUOUS under ITS options is skipped rather than allowed to
      // flood every literal in as a `certain` build (the cardinal false-certain lie).
      resolve: (program, programChecker) => {
        const sf = program.getSourceFile(abs);
        if (sf === undefined) return undefined;
        const at = nodeAt(sf, offset);
        if (at === undefined) return undefined;
        const type = typeAtNode(programChecker, at);
        if (type === undefined || isVacuousTarget(programChecker, type)) return undefined;
        return {
          checker: programChecker,
          type,
          generic: isGenericTarget(type, programChecker.getSymbolAtLocation(at)),
        };
      },
      prepare: (n) => (ts.isObjectLiteralExpression(n) ? n : undefined),
      evaluate: (n, ctx, sourceFile, rel) => {
        const verdict = classifyConstructionSite(
          ctx.checker,
          n,
          ctx.checker.getTypeAtLocation(n),
          ctx.type,
          ctx.generic,
        );
        return verdict === undefined ? undefined : buildSite(host, sourceFile, rel, n, verdict);
      },
    },
  );
  // No fanned program resolved T to a non-vacuous type — a "couldn't", returned as a failure rather
  // than an `ok` shaped like a proven absence (§3.6).
  if (scan === undefined) return 'no non-vacuous type for the target in any program containing it';

  const { coverage } = scan;
  const notes: string[] = [];
  // A value target (a `const`/function the agent named) is type-checked over its INFERRED type —
  // still a coherent scan, but say so plainly so a `kind: 'value'` header is never read as "a type".
  if (target.kind === 'value') notes.push(valueTargetNote(target));
  return {
    target,
    sites: scan.sites,
    scannedLiterals: coverage.examined,
    scannedFiles: coverage.files,
    coverage,
    ...(coverage.candidates > coverage.examined
      ? { truncated: { examined: coverage.examined, candidates: coverage.candidates } }
      : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function buildSite(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  literal: ts.ObjectLiteralExpression,
  verdict: { confidence: Confidence; note?: string },
): ConstructionSite {
  const span = spanFromRange(sourceFile, rel, literal.getStart(sourceFile), literal.getEnd());
  const enc = enclosingConstruction(literal);
  const encloser =
    enc !== undefined ? encloserView(host, sourceFile, rel, enc) : moduleEncloser(host, rel);
  return {
    span,
    confidence: verdict.confidence,
    ...(verdict.note !== undefined ? { note: verdict.note } : {}),
    encloser,
  };
}
