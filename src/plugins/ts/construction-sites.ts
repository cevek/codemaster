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

import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import { pathScopePredicate } from './path-scope.ts';
import { encloserView, moduleEncloser, type EncloserView } from './encloser-view.ts';
import { classifyConstructionSite } from './construction-confidence.ts';
import { enclosingConstruction } from './construction-encloser.ts';
import {
  describeTarget,
  isVacuousTarget,
  isGenericTarget,
  emptyNote,
  valueTargetNote,
  vacuousNote,
} from './construction-target.ts';
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
  /** Object literals examined (assignability checked). */
  scannedLiterals: number;
  /** In-scope source files walked. */
  scannedFiles: number;
  /** Present when the candidate cap was hit: `examined` of `candidates` total. */
  truncated?: { examined: number; candidates: number };
  /** Honest caveats not tied to a site (e.g. an empty answer). */
  notes?: string[];
};

export interface ConstructionSitesOptions {
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Hard cap on object literals examined — the compute bound (§1/§19). */
  limit?: number | undefined;
}

/** Default scan cap: bounds the assignability checks on a whole-repo call (each is one
 *  `isTypeAssignableTo`). Narrow further with pathInclude. */
const DEFAULT_SCAN_CAP = 1000;

export function findConstructionSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: ConstructionSitesOptions,
): ConstructionSitesView | string {
  // The target-type resolution AND the assignability scan run in ONE program (assignability is
  // invalid ACROSS program versions), routed to the type-authority for `abs`: in a no-root repo
  // `host.service` is the fallback primary whose whole-repo glob pollutes the target type with
  // augmentation strays (t-593802) — and its cross-package scan is unsound against that polluted
  // type anyway. typeAuthorityFor returns the target's own-options program, so both the type and the
  // (single-program, per the op's disclosed contract) scan are sound.
  const program = host.typeAuthorityFor(abs).getProgram();
  if (program === undefined) return 'the TS program is unavailable';
  const checker = program.getTypeChecker();
  const targetFile = program.getSourceFile(abs);
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

  const targetGeneric = isGenericTarget(targetType, targetSym);
  const inScope = pathScopePredicate(options.pathInclude, options.pathExclude);
  const cap = options.limit ?? DEFAULT_SCAN_CAP;
  const sites: ConstructionSite[] = [];
  let examined = 0;
  let candidates = 0;
  let scannedFiles = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/') || sourceFile.isDeclarationFile) continue;
    const rel = host.relOf(sourceFile.fileName);
    // relOf returns an ABSOLUTE path for a file outside root (path-mapped / project-reference
    // spillover) — not ours to scan; a repo-relative path is never absolute (programTsFiles).
    if (path.isAbsolute(String(rel))) continue;
    if (!inScope(rel)) continue;
    scannedFiles++;

    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        candidates++;
        // Cap the EXPENSIVE assignability check; keep counting past it so truncation is honest.
        if (examined < cap) {
          examined++;
          const verdict = classifyConstructionSite(
            checker,
            n,
            checker.getTypeAtLocation(n),
            targetType,
            targetGeneric,
          );
          if (verdict !== undefined) sites.push(buildSite(host, sourceFile, rel, n, verdict));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sourceFile);
  }

  const truncated = candidates > examined;
  const notes: string[] = [];
  // A value target (a `const`/function the agent named) is type-checked over its INFERRED type —
  // still a coherent scan, but say so plainly so a `kind: 'value'` header is never read as "a type".
  if (target.kind === 'value') notes.push(valueTargetNote(target));
  const empty = emptyNote(sites.length, target, truncated);
  if (empty !== undefined) notes.push(empty);
  return {
    target,
    sites,
    scannedLiterals: examined,
    scannedFiles,
    ...(truncated ? { truncated: { examined, candidates } } : {}),
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
