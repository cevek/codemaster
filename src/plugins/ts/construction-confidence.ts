// Confidence classification for `construction_sites` (§3.3 honest uncertainty). The whole
// point of this op is to never assert a `certain` build of T when the checker's "yes" is
// vacuous or generic — so this module owns the demotion rules, split out of the scan so the
// scan stays a single responsibility under the line cap.
//
// Assignability is the checker's OWN `isTypeAssignableTo` over the literal's FRESH type. A
// fresh object literal is excess-property-checked there, exactly as `const _: T = <literal>`
// would be: `{id,name,role}` is NOT assignable to `{id,name}`. That is deliberate — it makes
// matches high-precision (no structural-superset flood) and faithful to the compiler's verdict
// at a real construction site (the literal is fresh + contextually typed by T there too).

import ts from 'typescript';
import type { Confidence } from '../../core/span.ts';

const ANY = ts.TypeFlags.Any;

export type SiteVerdict = { confidence: Confidence; note?: string };

/** `undefined` when the checker does NOT deem the literal assignable to T (not a construction
 *  site). Otherwise the confidence we can honestly assert:
 *   - `dynamic`: the literal's OWN type is `any`/error — assignable to every type vacuously.
 *   - `partial`: assignable, but the target is generic (assignability to a bare generic isn't
 *     concrete) OR a top-level member is `any` (a field of T satisfied by an any-value).
 *   - `certain`: a concrete, fully-typed literal the checker proves assignable. */
export function classifyConstructionSite(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression,
  literalType: ts.Type,
  targetType: ts.Type,
  targetGeneric: boolean,
): SiteVerdict | undefined {
  // A literal whose own type is `any` is assignable to EVERY target vacuously — never a proven
  // build of T. Object literals essentially never resolve to `any` (even `const x: any = {…}`
  // keeps the literal's structural type), so this is cheap insurance for an `as any` / untyped
  // boundary, not a common path.
  if ((literalType.flags & ANY) !== 0) {
    return {
      confidence: 'dynamic',
      note: 'the literal’s type is `any` — assignable to any type vacuously, not a proven construction of T',
    };
  }
  if (!checker.isTypeAssignableTo(literalType, targetType)) return undefined;
  if (targetGeneric) {
    return {
      confidence: 'partial',
      note: 'target type is generic — assignability to the bare generic is not concretely proven',
    };
  }
  // Excess-checking already rejected stray fields, so a surviving any-member is a field OF T
  // satisfied by an any-value — a precise "not concretely proven" signal, not noise.
  if (hasAnyMember(checker, literal, literalType)) {
    return {
      confidence: 'partial',
      note: 'a member’s type is `any` — a field of T is satisfied by an any-value; not concretely proven',
    };
  }
  return { confidence: 'certain' };
}

/** Shallow (top-level only — bounded, no recursion) check: any own property of the literal
 *  resolving to `any`/error. Member types resolved AT the literal node. */
function hasAnyMember(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression,
  literalType: ts.Type,
): boolean {
  for (const prop of literalType.getProperties()) {
    const propType = checker.getTypeOfSymbolAtLocation(prop, literal);
    if ((propType.flags & ANY) !== 0) return true;
  }
  return false;
}
