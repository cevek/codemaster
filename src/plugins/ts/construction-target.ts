// Target classification + honest notes for `construction_sites` — split out of
// `construction-sites.ts` (300-line cap). Given the node/symbol the agent named, this decides WHAT
// the target is (a type vs a value), whether it is a vacuous top/open type every literal satisfies,
// whether it is generic, and the §3.4/§3.6 caveats a 0-site or value-resolved answer must carry.
// Pure classification over the checker — no scanning; the scan loop stays in construction-sites.ts.

import ts from 'typescript';
import { spanFromRange } from './spans.ts';
import type { TsProjectHost } from './ls-host.ts';
import type { ConstructionTarget } from './construction-sites.ts';

export function describeTarget(
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
export function isVacuousTarget(checker: ts.TypeChecker, type: ts.Type): boolean {
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
export function isGenericTarget(targetType: ts.Type, symbol: ts.Symbol | undefined): boolean {
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

/** A 0-site answer must not read as "none exist" (§3.4). When the cap was hit, MORE candidates
 *  were left unscanned — say so, never assert non-existence (a completeness lie an agent could act
 *  on by deleting the field/type). Only a complete (untruncated) scan may state "none in scope". */
export function emptyNote(
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
export function valueTargetNote(target: ConstructionTarget): string {
  return `target '${target.name}' resolves to a VALUE, not a type — reporting object literals assignable to its inferred type; pass a type name (interface/type/class) for the intended "what builds T" query`;
}

/** A top/open target accepts every object literal — not a meaningful construction query (§3). */
export function vacuousNote(target: ConstructionTarget): string {
  return `target ${target.kind} ${target.name} is a top/open type ({}, any, unknown, object, or an unknown-valued index signature) — every object literal trivially satisfies it, so reporting "construction sites" would be meaningless; pick a concrete type with required fields`;
}
