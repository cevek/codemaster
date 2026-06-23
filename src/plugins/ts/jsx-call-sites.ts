// A GENERIC syntactic scan of a symbol's JSX call-sites (§5-L2) — the seam the `react` plugin
// (`deps: ['ts']`) consumes to read which props a component is PASSED. Domain-NEUTRAL: JSX is a
// TS-language construct, and this reports only the syntactic attribute set per `<Tag .../>` site;
// the react CONVENTION (what a "component"/"prop" is) lives in plugins/react, never here (§4).
//
// Anchored on the live LS's `findReferencesAcross` (the only oracle, §3.1) so it is ALIAS-SAFE:
// `import { Button as B }` … `<B/>` resolves to the same symbol, which a textual JSX scan misses.
// HONESTY (the consumer's #1 risk — a live prop falsely called dead): a `{...spread}` attribute is
// a `dynamic` boundary (any prop could flow through it), and a reference that is NOT a readable
// `<Tag/>` element — a factory `createElement(C, …)` call, or a value read/write (`memo(C)`,
// `const D = C`) — makes the passed set UNREADABLE. Both are surfaced (`hasSpread`, `opaqueRefs`)
// so the consumer demotes its verdicts rather than lie. Bounded: the reference set is hard-capped
// (§19) and the cap reported as truncation — never a silent partial read.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import type { TsProjectHost } from './ls-host.ts';
import { findReferencesAcross } from './cross-program.ts';
import { classifyRole } from './usage-roles.ts';
import { nodeAt } from './ast-node.ts';
import { spanFromRange } from './spans.ts';

/** Hard cap on references inspected per target (§19 never-hang). `findReferencesAcross` is
 *  itself bounded/cancellable; this bounds the per-site attribute reads and the result size. */
const SITE_CAP = 2000;

/** One readable `<Tag .../>` reference of the target, with the props passed AT that site. */
export type JsxCallSite = {
  /** The tag-name token span (proof). */
  span: Span;
  /** Named JSX attributes passed here (`size`, `onClick`); a namespaced name kept verbatim. */
  attrNames: string[];
  /** A `{...x}` spread attribute is present — a dynamic boundary: any prop may flow through it. */
  hasSpread: boolean;
  /** The program that surfaced this ref — populated only in a multi-program repo (Task G). */
  program?: string;
};

/** A reference of the target that is NOT a readable JSX element: a factory call
 *  (`React.createElement(C, props)`) or a value read/write (`memo(C)`, `const D = C`). The props
 *  it passes cannot be read syntactically, so the consumer must demote its unused verdicts. */
export type JsxOpaqueRef = {
  span: Span;
  /** `call` (createElement/factory) | `read` | `write` — never a JSX element. */
  role: 'call' | 'read' | 'write';
  program?: string;
};

export type JsxCallSitesView = {
  sites: JsxCallSite[];
  opaqueRefs: JsxOpaqueRef[];
  /** Reference set capped (§19) — unseen sites may pass a prop, so the consumer cannot claim a
   *  prop certainly-unused. Absent when the whole set was inspected. */
  truncated?: { shown: number; total: number };
};

/** Scan the JSX call-sites of the symbol at `offset`. `undefined` mirrors the
 *  `findReferencesAcross === undefined` contract (no symbol resolves there). */
export function scanJsxCallSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
): JsxCallSitesView | undefined {
  const cross = findReferencesAcross(host, abs, offset);
  if (cross === undefined) return undefined;
  const multiProgram = host.programs().length > 1;
  const sites: JsxCallSite[] = [];
  const opaqueRefs: JsxOpaqueRef[] = [];
  const total = cross.refs.length;
  const capped = total > SITE_CAP;
  const refs = capped ? cross.refs.slice(0, SITE_CAP) : cross.refs;

  for (const ref of refs) {
    const role = classifyRole(ref.sourceFile, ref.start, {
      isDefinition: ref.isDefinition,
      isWrite: ref.isWriteAccess,
    });
    // Harmless reference contexts — the decl itself, imports/re-exports, type positions, and the
    // `</X>` closing token already counted at the opening tag — neither pass nor obscure props.
    if (
      role === 'decl' ||
      role === 'import' ||
      role === 'reexport' ||
      role === 'type' ||
      role === 'jsx-closing'
    ) {
      continue;
    }
    const span = spanFromRange(ref.sourceFile, ref.rel, ref.start, ref.start + ref.length);
    const programField = multiProgram ? { program: ref.program } : {};
    if (role === 'jsx') {
      const attrs = readJsxAttributes(ref.sourceFile, ref.start);
      sites.push({ span, attrNames: attrs.names, hasSpread: attrs.hasSpread, ...programField });
    } else {
      // 'call' | 'read' | 'write' — the component is used in a way whose props can't be read.
      opaqueRefs.push({ span, role, ...programField });
    }
  }

  return {
    sites,
    opaqueRefs,
    ...(capped ? { truncated: { shown: SITE_CAP, total } } : {}),
  };
}

/** The named attributes + spread presence of the JSX element whose tag name sits at `position`. */
function readJsxAttributes(
  sourceFile: ts.SourceFile,
  position: number,
): { names: string[]; hasSpread: boolean } {
  const node = nodeAt(sourceFile, position);
  const opening = node !== undefined ? enclosingJsxOpening(node) : undefined;
  if (opening === undefined) return { names: [], hasSpread: false };
  const names: string[] = [];
  let hasSpread = false;
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(prop)) {
      hasSpread = true;
      continue;
    }
    if (ts.isJsxAttribute(prop)) {
      names.push(ts.isIdentifier(prop.name) ? prop.name.text : prop.name.getText(sourceFile));
    }
  }
  // JSX element CONTENT (`<C>body</C>`) passes the `children` prop — a separate channel from the
  // `children={…}` attribute (already captured above). Without this a content-passed `children`
  // reads as never-passed → a false certain-dead (a mass React pattern). A self-closing element has
  // no content; whitespace-only text (`<C>\n</C>`) is not content.
  const parent = opening.parent;
  if (
    ts.isJsxOpeningElement(opening) &&
    ts.isJsxElement(parent) &&
    parent.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces)) &&
    !names.includes('children')
  ) {
    names.push('children');
  }
  return { names, hasSpread };
}

/** Nearest enclosing JSX opening / self-closing element from a tag-name position; `undefined`
 *  past a statement boundary (a jsx ref is always inside its own element, so this terminates). */
function enclosingJsxOpening(
  node: ts.Node,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined {
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (ts.isJsxOpeningElement(up) || ts.isJsxSelfClosingElement(up)) return up;
    if (ts.isStatement(up)) return undefined;
  }
  return undefined;
}
