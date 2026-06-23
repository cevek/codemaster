// A GENERIC syntactic scan of the JSX elements rendered in the BODY of one declaration (§5-L2) —
// the seam trace ops consume to follow a value DOWN a component tree (where does a prop / field
// flow). Domain-NEUTRAL: JSX is a TS-language construct, and this reports only the syntactic
// `<Tag .../>` sites in the target's body — their tag-name token (a chainable target), the named
// attributes with their value source, and `{...spread}` presence. The react CONVENTION (what a
// "component" / "prop" is) lives in plugins/react and is applied by the op via `classify` on the
// tag span — never here (§4). The inverse of `jsx-call-sites.ts` (that one: where is THIS symbol
// mounted; this one: what does THIS body mount).
//
// HONESTY (§3.4 completeness): the scan OVER-collects ALL JSX in the body — INCLUDING inside
// nested callbacks (`items.map(i => <Item value={x}/>)`, a closure-captured flow) and in
// attribute-value position (`<Layout header={<Title value={x}/>}/>`, a render prop). The question
// is "where can a value FLOW," not "what does this function RETURN" (the jsx-return.ts model that
// stops at nested functions) — under-collecting would silently drop a real indirect flow, a lie.
// Over-collecting is harmless: a site with no matching attribute yields no hop at the op level.
// A `{...spread}` is surfaced (`hasSpread`) and a `{ident}` value is flagged (`valueIdent`) so the
// consumer demotes / flags rather than guess. Bounded (§19): a single-body scan (never per-repo),
// the site set hard-capped and the cap reported.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import type { TsProjectHost } from './ls-host.ts';
import { nodeAt } from './ast-node.ts';
import { spanFromRange } from './spans.ts';

/** Hard cap on sites collected per body (§19 never-hang) — a body is already bounded, this bounds
 *  a generated monster. The cap is reported as `truncated`, never a silent partial read. */
const SITE_CAP = 2000;
/** Per-attribute value-text cap — the value is a forward/derived SIGNAL, not a payload. */
const VALUE_TEXT_CAP = 120;

/** One JSX attribute passed at a site. `valueText` is the value SOURCE (a string literal's content,
 *  or the `{expr}` text) — proof, and the signal for a derived (non-forward) flow. `valueIdent` is
 *  set when the value is a bare `{identifier}` (the destructured-prop forward signal: `{userId}`);
 *  `valueMember` is the TRAILING member when the value is a property access (`{props.userId}` →
 *  `userId`) — the non-destructured forward signal. The op reads either as "this prop flows here". */
export type JsxChildAttr = {
  name: string;
  valueText?: string;
  valueIdent?: string;
  valueMember?: string;
};

/** One `<Tag .../>` rendered in the body. `tagSpan` is the tag-name token (proof AND a chainable
 *  `classify` / `find_definition` target). `hasSpread` flags a `{...x}` — a dynamic boundary any
 *  prop may flow through. */
export type JsxChildSite = {
  tagName: string;
  tagSpan: Span;
  attrs: JsxChildAttr[];
  hasSpread: boolean;
};

export type JsxChildSitesView = {
  sites: JsxChildSite[];
  /** The target did not resolve to a function-like declaration with a body (nothing to scan). */
  noBody: boolean;
  /** Site set capped at `SITE_CAP` (§19) — unseen sites may forward the value. Absent when the
   *  whole body was scanned. */
  truncated?: { shown: number; total: number };
};

/** Scan the JSX child-sites in the body of the declaration at `offset`. `undefined` when no
 *  program/source resolves (mirrors the other single-file reads). */
export function scanJsxChildSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
): JsxChildSitesView | undefined {
  const program = host.service.getProgram();
  const sourceFile = program?.getSourceFile(abs);
  if (program === undefined || sourceFile === undefined) return undefined;
  const node = nodeAt(sourceFile, offset);
  if (node === undefined) return undefined;
  const body = bodyOfDeclAt(node);
  if (body === undefined) return { sites: [], noBody: true };

  const rel = host.relOf(sourceFile.fileName);
  const sites: JsxChildSite[] = [];
  let total = 0;
  const visit = (n: ts.Node): void => {
    const opening = openingElementOf(n);
    if (opening !== undefined) {
      total += 1;
      if (sites.length < SITE_CAP) sites.push(buildSite(sourceFile, rel, opening));
    }
    ts.forEachChild(n, visit); // descend through EVERYTHING — callbacks, attr-value JSX, nested fns
  };
  // `visit(body)` — NOT `forEachChild(body, …)` — so a CONCISE arrow body that IS a JSX element
  // (`() => <Child/>`) is itself inspected, not just its children (the depth-chain bug otherwise).
  visit(body);

  return {
    sites,
    noBody: false,
    ...(total > sites.length ? { truncated: { shown: sites.length, total } } : {}),
  };
}

/** The function-like body enclosing (or initialized by) `node` — the same climb as
 *  `firstParameterOf` (first-param-members.ts), but yielding the BODY: `function f(){…}`, a method,
 *  `const C = (…) => …` / `= function(){}`, and the call-wrapped `const C = memo((…) => …)`. */
function bodyOfDeclAt(node: ts.Node): ts.ConciseBody | undefined {
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (
      ts.isFunctionDeclaration(up) ||
      ts.isFunctionExpression(up) ||
      ts.isArrowFunction(up) ||
      ts.isMethodDeclaration(up)
    ) {
      return up.body;
    }
    if (ts.isVariableDeclaration(up) && up.initializer !== undefined) {
      return functionOfInitializer(up.initializer)?.body;
    }
  }
  return undefined;
}

/** The function carried by a binding initializer — a direct arrow/function-expression, or the first
 *  such argument of a HOC call (`forwardRef`/`memo`/…). Mirrors first-param-members.ts. */
function functionOfInitializer(
  init: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  if (ts.isCallExpression(init)) {
    for (const arg of init.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
    }
  }
  return undefined;
}

/** The opening of a JSX element, or `undefined`. A `<X>…</X>` is counted at its opening tag (the
 *  closing token is skipped); a self-closing `<X/>` is its own node; a fragment `<>…</>` has no tag. */
function openingElementOf(n: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined {
  if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) return n;
  return undefined;
}

function buildSite(
  sourceFile: ts.SourceFile,
  rel: ReturnType<TsProjectHost['relOf']>,
  el: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): JsxChildSite {
  const tagSpan = spanFromRange(
    sourceFile,
    rel,
    el.tagName.getStart(sourceFile),
    el.tagName.getEnd(),
  );
  const attrs: JsxChildAttr[] = [];
  let hasSpread = false;
  for (const prop of el.attributes.properties) {
    if (ts.isJsxSpreadAttribute(prop)) {
      hasSpread = true;
      continue;
    }
    if (ts.isJsxAttribute(prop)) attrs.push(readAttribute(sourceFile, prop));
  }
  return { tagName: el.tagName.getText(sourceFile), tagSpan, attrs, hasSpread };
}

/** Read one named attribute's name + value signal. `value="x"` → `valueText` only; `value={ident}`
 *  → `valueIdent` (destructured forward) + `valueText`; `value={a.b}` → `valueMember` ('b', the
 *  non-destructured forward) + `valueText`; any other `value={expr}` → `valueText` only (derived);
 *  a valueless boolean attribute → name only. */
function readAttribute(sourceFile: ts.SourceFile, attr: ts.JsxAttribute): JsxChildAttr {
  const out: JsxChildAttr = { name: attr.name.getText(sourceFile) };
  const init = attr.initializer;
  if (init === undefined) return out;
  if (ts.isStringLiteralLike(init)) {
    out.valueText = cap(init.text);
    return out;
  }
  if (ts.isJsxExpression(init) && init.expression !== undefined) {
    const expr = init.expression;
    out.valueText = cap(expr.getText(sourceFile));
    if (ts.isIdentifier(expr)) out.valueIdent = expr.text;
    else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
      out.valueMember = expr.name.text;
    }
  }
  return out;
}

function cap(s: string): string {
  return s.length > VALUE_TEXT_CAP ? `${s.slice(0, VALUE_TEXT_CAP)}…` : s;
}
