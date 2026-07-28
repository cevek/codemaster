// A GENERIC syntactic read of the ATTRIBUTES (name + value) of the JSX element whose tag-name
// token sits at a given position — the value half `jsx-call-sites.ts` (names only) does not carry,
// on the symbol-anchored side of the scan (`jsx-child-sites.ts` reads values, but for the INVERSE
// question: what does THIS body mount). Domain-NEUTRAL: JSX is a TS-language construct; what a
// "prop" means is react policy and lives in plugins/react (§4).
//
// HONESTY (§3.3) — the value is THREE-state, never two:
//   literal  — a statically-readable value (`"x"`, `{'x'}`, `{false}`, `{0}`, a bare `disabled`)
//   dynamic  — any other expression (`{!isView}`, `{mode}`): the prop IS passed, the value is not
//              knowable statically. Reported WITH its source text, never dropped.
//   (absent) — plus the element-level `hasSpread`, under which ANY prop may still flow.
// Dropping either uncertainty is the silent miss this module exists to prevent.

import ts from 'typescript';
import { elideString } from '../../common/truncate/elide-string.ts';
import { enclosingJsxOpening } from './jsx-element-at.ts';
import { nodeAt } from './ast-node.ts';

/** Per-attribute value-text cap — the value is a SIGNAL for the agent, not a payload (§12). */
const VALUE_TEXT_CAP = 120;

/** One named attribute of a JSX site. `value` is the NORMALIZED literal text for
 *  `kind:'literal'` (so `variant="x"`, `variant={'x'}` and a bare `disabled` are comparable), and
 *  the (elided) expression SOURCE for `kind:'dynamic'`. */
export type JsxAttrValue = { name: string; kind: 'literal' | 'dynamic'; value: string };

/** The attribute set of one `<Tag .../>` site. */
export type JsxSiteAttrs = { attrs: JsxAttrValue[]; hasSpread: boolean };

/** Read the attributes of the JSX element whose tag-name token sits at `position`.
 *  `undefined` when the position is not inside a JSX element (never a fabricated empty set —
 *  "no attributes" and "not an element" are different facts). */
export function readJsxSiteAttrs(
  sourceFile: ts.SourceFile,
  position: number,
): JsxSiteAttrs | undefined {
  const node = nodeAt(sourceFile, position);
  const opening = node !== undefined ? enclosingJsxOpening(node) : undefined;
  if (opening === undefined) return undefined;
  const attrs: JsxAttrValue[] = [];
  let hasSpread = false;
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(prop)) {
      hasSpread = true;
      continue;
    }
    if (ts.isJsxAttribute(prop)) attrs.push(readAttribute(sourceFile, prop));
  }
  return { attrs, hasSpread };
}

/** Normalize one attribute's value. The spellings that MUST compare equal:
 *  `x="a"` / `x={'a'}` → `a`; `x={false}` → `false`; `x={0}` → `0`; a bare `x` → `true`
 *  (JSX's own shorthand). Anything else is `dynamic` carrying its source text. */
function readAttribute(sourceFile: ts.SourceFile, attr: ts.JsxAttribute): JsxAttrValue {
  const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText(sourceFile);
  const init = attr.initializer;
  // A valueless attribute is JSX shorthand for `={true}` — a literal, not an absent value.
  if (init === undefined) return { name, kind: 'literal', value: 'true' };
  if (ts.isStringLiteralLike(init)) return { name, kind: 'literal', value: init.text };
  if (ts.isJsxExpression(init) && init.expression !== undefined) {
    const literal = literalTextOf(init.expression);
    if (literal !== undefined) return { name, kind: 'literal', value: literal };
    return { name, kind: 'dynamic', value: cap(init.expression.getText(sourceFile)) };
  }
  // `x={}` (an empty JSX expression) passes nothing readable — honestly dynamic, not `true`.
  return { name, kind: 'dynamic', value: '' };
}

/** The normalized literal text of an expression, or `undefined` when it is not a literal. */
function literalTextOf(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null';
  // `{-1}` — a negated numeric literal is still a static value.
  if (
    ts.isPrefixUnaryExpression(expr) &&
    (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return `${expr.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${expr.operand.text}`;
  }
  return undefined;
}

function cap(s: string): string {
  // Char-elide through the `common/truncate` chokepoint — a value PREVIEW, never a silent cut.
  return elideString(s.replace(/\s+/g, ' '), VALUE_TEXT_CAP).text;
}
