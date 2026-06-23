// The PURE type-relationship verdict behind `trace_type_widening` (§3.3 honest uncertainty):
// did a value's type WIDEN — lose precision — when it flowed from `src` into `sink`? Factored out
// of the flow-walk (type-widening.ts) so the "is this a widening" rule lives in ONE place, mirroring
// `construction-confidence.ts` (the assignability-verdict precedent). No AST, no scanning — just the
// checker's own type relationships, so it can never disagree with the compiler (§3.1: one oracle).
//
// THE #1 TRAP (why `any` is checked FIRST): `isTypeAssignableTo` is true in BOTH directions for
// `any` — so the strict-wider test (`src→sink && !sink→src`) would read concrete→`any` as "not
// widened" and `any`→concrete as "widened". Both are lies. `any`/`unknown` are handled before the
// bidirectional test, exactly as `construction-confidence` guards the vacuous-`any` literal.

import ts from 'typescript';
import type { Confidence } from '../../core/span.ts';

export type WideningKind =
  | 'literal-widening' // a literal lost its literalness: 'red' → string, 42 → number, true → boolean
  | 'union-widened' // narrowed to a strictly larger union: 'a' → 'a' | 'b'
  | 'to-any' // flowed into `any` — precision ERASED (a boundary; the walk stops here)
  | 'to-unknown' // flowed into `unknown` — precision lost until re-narrowed (a boundary)
  | 'narrowing-lost'; // some other strict widening the checker proves (T → supertype)

/** The verdict for one flow hop. `widened: false` carries no kind (a preserved/narrowed hop).
 *  `stop` marks a precision-ERASING boundary (`any`/`unknown`): the walk must NOT continue past it —
 *  the value is no longer the same precise thing (§3.3: flag the boundary, never silently bridge). */
export type WideningVerdict = {
  widened: boolean;
  kind?: WideningKind;
  /** `certain` for a clean assignability proof; `dynamic` at an `any`/`unknown` boundary. */
  confidence: Confidence;
  stop?: boolean;
  note?: string;
};

const ANY = ts.TypeFlags.Any;
const UNKNOWN = ts.TypeFlags.Unknown;
const LITERAL =
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.BigIntLiteral |
  ts.TypeFlags.EnumLiteral;

const NOT_WIDENED: WideningVerdict = { widened: false, confidence: 'certain' };

/** Did `src` widen into `sink`? `any`/`unknown` FIRST (vacuous bidirectional assignability), then
 *  the strict-wider test: `src` assignable to `sink` but NOT vice-versa means `sink` is strictly
 *  larger — a real precision loss. Equal/narrower/unrelated → not a widening. */
export function classifyWidening(
  checker: ts.TypeChecker,
  src: ts.Type,
  sink: ts.Type,
): WideningVerdict {
  // Boundary cases first — see the §-trap note above.
  if ((sink.flags & ANY) !== 0) {
    if ((src.flags & ANY) !== 0) return NOT_WIDENED; // any → any: nothing lost
    return {
      widened: true,
      kind: 'to-any',
      confidence: 'dynamic',
      stop: true,
      note: 'value flows into `any` — its type is erased (assignable both ways); precision lost here',
    };
  }
  if ((sink.flags & UNKNOWN) !== 0) {
    if ((src.flags & (ANY | UNKNOWN)) !== 0) return NOT_WIDENED;
    return {
      widened: true,
      kind: 'to-unknown',
      confidence: 'dynamic',
      stop: true,
      note: 'value flows into `unknown` — precision lost until it is re-narrowed',
    };
  }
  // A src that is ALREADY `any`/`unknown` cannot widen further (it is maximally wide); reading it
  // as a widening into a concrete sink would be backwards.
  if ((src.flags & (ANY | UNKNOWN)) !== 0) return NOT_WIDENED;

  const srcToSink = checker.isTypeAssignableTo(src, sink);
  const sinkToSrc = checker.isTypeAssignableTo(sink, src);
  // Not assignable (unrelated types — not a flow widening), or sink assignable back to src (equal or
  // NARROWER) → no precision lost. Only strictly-wider sink is a widening.
  if (!srcToSink || sinkToSrc) return NOT_WIDENED;

  if (isLiteral(src) && !isLiteral(sink)) {
    return { widened: true, kind: 'literal-widening', confidence: 'certain' };
  }
  if (sink.isUnion()) {
    return { widened: true, kind: 'union-widened', confidence: 'certain' };
  }
  return { widened: true, kind: 'narrowing-lost', confidence: 'certain' };
}

/** A primitive LITERAL type (`'red'`, `42`, `true`, an enum member) — the narrow end of the
 *  canonical literal→primitive widening. A union of literals is NOT itself a literal (it is already
 *  a step wider), so it falls through to the union/narrowing classification. */
function isLiteral(type: ts.Type): boolean {
  return (type.flags & LITERAL) !== 0;
}
