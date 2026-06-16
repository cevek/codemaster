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
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId, moduleName } from './symbol-id.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import { classifyConstructionSite } from './construction-confidence.ts';
import { enclosingConstruction, type ConstructionEncloser } from './construction-encloser.ts';
import type { TsProjectHost } from './ls-host.ts';

type ConstructionEncloserView = {
  /** Chainable ts: SymbolId of the enclosing declaration (→ find_usages / source / rename). */
  id: string;
  name: string;
  kind: string;
  file: RepoRelPath;
  line: number;
  col: number;
  exported: boolean;
};

export type ConstructionSite = {
  /** The object-literal span — proof of WHERE the construction is (§3.1). */
  span: Span;
  confidence: Confidence;
  /** Why a non-`certain` confidence (vacuous `any` / generic boundary). */
  note?: string;
  encloser: ConstructionEncloserView;
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
  const program = host.service.getProgram();
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
  const inScope = scopePredicate(host, options);
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

function encloserView(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  enc: ConstructionEncloser,
): ConstructionEncloserView {
  const lc = sourceFile.getLineAndCharacterOfPosition(enc.nameStart);
  const line = lc.line + 1;
  const col = lc.character + 1;
  return {
    // Mint on the BARE token (`enc.idName`) so the handle chains — a class member's display name
    // is `Class.member`, but its id must anchor on the `member` token at line:col (§6 rebind).
    id: mintSymbolId(enc.idName, rel, line, col, host.rootTag),
    name: enc.name,
    kind: enc.kind,
    file: rel,
    line,
    col,
    exported: enc.exported,
  };
}

/** A literal at module top level (not inside any named declaration) rolls up to the file. */
function moduleEncloser(host: TsProjectHost, rel: RepoRelPath): ConstructionEncloserView {
  const name = moduleName(rel);
  return {
    id: mintSymbolId(name, rel, 1, 1, host.rootTag),
    name,
    kind: 'module',
    file: rel,
    line: 1,
    col: 1,
    exported: false,
  };
}

function describeTarget(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  symbol: ts.Symbol | undefined,
): ConstructionTarget {
  const rel = host.relOf(sourceFile.fileName);
  const span = spanFromRange(sourceFile, rel, node.getStart(sourceFile), node.getEnd());
  const name = ts.isIdentifier(node) ? node.text : (symbol?.getName() ?? span.text);
  return { name, kind: targetKind(symbol), span };
}

/** The target's kind. `'value'` (NOT `'type'`) is the honest fallthrough when the symbol has no
 *  type-declaring declaration — a `const`/function/parameter the agent named: the scan still runs
 *  over its inferred type, but a `kind: 'type'` header on a value would be a §3 mislabel. */
function targetKind(symbol: ts.Symbol | undefined): string {
  for (const decl of symbol?.declarations ?? []) {
    if (ts.isInterfaceDeclaration(decl)) return 'interface';
    if (ts.isTypeAliasDeclaration(decl)) return 'type';
    if (ts.isClassDeclaration(decl)) return 'class';
    if (ts.isEnumDeclaration(decl)) return 'enum';
  }
  return 'value';
}

/** A TOP/OPEN target every object literal trivially satisfies — `any`/`unknown`/`object`, the
 *  global `Object`, `{}` / a marker interface (no props, no index signature), `Record<string,
 *  unknown>` (an index signature whose value is `any`/`unknown`), or a union with such an arm.
 *  Reporting every literal as a `certain` build of such a target is the cardinal false-certain lie,
 *  so the op short-circuits. A CONSTRAINING shape (`Record<string, number>`, all-optional `{a?;b?}`)
 *  is NOT vacuous — it can reject a literal — so it stays a real query. */
function isVacuousTarget(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) !== 0) {
    return true;
  }
  if (type.isUnion()) return type.types.some((t) => isVacuousTarget(checker, t));
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    // The global `Object` accepts EVERY object literal — its only members are `Object.prototype`
    // methods, satisfied by every object, so it constrains nothing even though `getProperties()`
    // is non-empty. Catch it before the property-count check, or it floods (bug-reviewer §1, 2nd pass).
    if (isGlobalObjectType(type)) return true;
    if (type.getProperties().length > 0) return false; // has a named field a literal could miss
    const indexInfos = checker.getIndexInfosOfType(type);
    if (indexInfos.length === 0) return true; // {} / marker interface — accepts everything
    // An index signature constrains only when its VALUE type is concrete; an any/unknown value
    // (Record<string, unknown>) imposes nothing a literal could fail.
    return indexInfos.every(
      (info) => (info.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
    );
  }
  return false;
}

/** The lib global `Object` interface (NOT a user `interface Object {}`): its symbol is named
 *  `Object` and is declared in a default-lib `.d.ts` (`lib.es5.d.ts`, …). Every object literal is
 *  assignable to it, so it is vacuous despite carrying prototype-method properties. */
function isGlobalObjectType(type: ts.Type): boolean {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol?.getName() !== 'Object') return false;
  return (symbol.declarations ?? []).some((decl) => {
    const sourceFile = decl.getSourceFile();
    return sourceFile.isDeclarationFile && /(^|\/)lib\.[^/]*\.d\.ts$/.test(sourceFile.fileName);
  });
}

/** True when assignability to the target is loose because it is generic — a bare type
 *  parameter, or a declaration carrying type parameters (`interface Box<V>`). Every match is
 *  then demoted to `partial`: assignability to the un-instantiated generic is not concrete. */
function isGenericTarget(targetType: ts.Type, symbol: ts.Symbol | undefined): boolean {
  if ((targetType.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
  for (const decl of symbol?.declarations ?? []) {
    if (
      (ts.isInterfaceDeclaration(decl) ||
        ts.isClassDeclaration(decl) ||
        ts.isTypeAliasDeclaration(decl)) &&
      (decl.typeParameters?.length ?? 0) > 0
    ) {
      return true;
    }
  }
  return false;
}

function scopePredicate(
  host: TsProjectHost,
  options: ConstructionSitesOptions,
): (rel: RepoRelPath) => boolean {
  const inc = options.pathInclude;
  const exc = options.pathExclude;
  return (rel) => {
    if (inc !== undefined && inc.length > 0 && !matchesAnyGlob(rel, inc)) return false;
    if (exc !== undefined && exc.length > 0 && matchesAnyGlob(rel, exc)) return false;
    return true;
  };
}

/** A 0-site answer must not read as "none exist" (§3.4). When the cap was hit, MORE candidates
 *  were left unscanned — say so, never assert non-existence (a completeness lie an agent could act
 *  on by deleting the field/type). Only a complete (untruncated) scan may state "none in scope". */
function emptyNote(
  siteCount: number,
  target: ConstructionTarget,
  truncated: boolean,
): string | undefined {
  if (siteCount > 0) return undefined;
  if (truncated) {
    return `no assignable literal among the examined candidates — but the cap was hit and MORE candidates are unscanned; raise limit or narrow pathInclude before concluding nothing builds ${target.kind} ${target.name}`;
  }
  return `no object literal is assignable to ${target.kind} ${target.name} in scope — a literal missing a required field (or with an excess one) is correctly excluded; verify the target is a TYPE and widen pathInclude if you scoped it`;
}

/** A target the agent named resolved to a VALUE, not a type — stated plainly (§3.6). */
function valueTargetNote(target: ConstructionTarget): string {
  return `target '${target.name}' resolves to a VALUE, not a type — reporting object literals assignable to its inferred type; pass a type name (interface/type/class) for the intended "what builds T" query`;
}

/** A top/open target accepts every object literal — not a meaningful construction query (§3). */
function vacuousNote(target: ConstructionTarget): string {
  return `target ${target.kind} ${target.name} is a top/open type ({}, any, unknown, object, or an unknown-valued index signature) — every object literal trivially satisfies it, so reporting "construction sites" would be meaningless; pick a concrete type with required fields`;
}
