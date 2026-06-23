// A GENERIC syntactic projection of a property symbol's member-read sites, each tagged with the
// TSX-language fact that decides "is this a render?": the nearest enclosing JSX position
// (intrinsic-host element vs value-based element, child vs attribute). The seam `trace_field_to_render`
// consumes to answer "which components render `User.email`" (§17 Phase 6).
//
// It is a DIFFERENT PROJECTION of the same LS primitive `find_usages` rides — ONE `findReferencesAcross`
// pass (alias-safe, member-level by construction: references of the PROPERTY symbol are exactly the
// `obj.email` accesses, not any `email`) — NOT a second find_usages call (two passes could disagree, §3).
// Per ref it adds the JSX-position classification + `findEncloser`, reusing the usage-roles helpers.
//
// DOMAIN-NEUTRAL (§4): the intrinsic-vs-value distinction is a TSX-language fact (TS itself splits
// `IntrinsicElements` from value-based elements by tag capitalization), NOT a react convention. The
// MEANING ("intrinsic → the enclosing component renders it; value → it is passed to a child component")
// is the op's interpretation, applied above this seam. HONESTY: member-level references DO NOT see a
// computed `obj[k]`, a spread `{...obj}`, or a destructured local's downstream reads — a destructure
// binding is FLAGGED (`kind:'destructure'`) so the op never counts it as a proven render; the rest is
// the op's stated floor. Bounded: the reference set is hard-capped (§19) and the cap reported.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';
import type { TsProjectHost } from './ls-host.ts';
import { findReferencesAcross } from './cross-program.ts';
import { classifyRole, findEncloser } from './usage-roles.ts';
import { nodeAt } from './ast-node.ts';
import { spanFromRange } from './spans.ts';

/** Hard cap on references inspected per target (§19 never-hang). `findReferencesAcross` is itself
 *  bounded/cancellable; this bounds the per-site AST classification and the result size. */
const SITE_CAP = 2000;

/** The nearest enclosing JSX position of a member-read, the render-deciding fact:
 *  `intrinsic-*` = inside a host element (`<span>{x}</span>` / `<input value={x}/>`) → the enclosing
 *  component RENDERS it. `value-*` = inside a value-based element (`<Avatar email={x}/>`) → it is
 *  PASSED to that component, which decides the render (prop-flow, not a render here). `none` = not in
 *  a JSX expression position (a plain logic read, or an indirection through a local/callback). */
export type FieldReadJsx =
  | 'intrinsic-child'
  | 'intrinsic-attr'
  | 'value-child'
  | 'value-attr'
  | 'none';

/** The enclosing named declaration of a read — the chainable address the op hands `react.classify`
 *  to decide component/hook. `undefined` → the read sits at module top level. */
export type FieldReadEncloser = {
  name: string;
  idName: string;
  kind: string;
  span: Span;
  exported: boolean;
};

/** One member-read of the property, with the facts the op maps to a render verdict. `kind`
 *  distinguishes a plain `read`, an assignment `write`, and a `destructure` binding (`const {email}=u`)
 *  whose downstream local reads are INVISIBLE to member-level references — the op's honesty floor. */
export type FieldReadSite = {
  /** The property-name token span (proof). */
  span: Span;
  jsx: FieldReadJsx;
  /** The enclosing JSX tag verbatim when `jsx !== 'none'` (`span`, `Avatar`, `Foo.Bar`). */
  tag?: string;
  kind: 'read' | 'write' | 'destructure';
  enclosing?: FieldReadEncloser;
  /** The program that surfaced this ref — populated only in a multi-program repo (Task G). */
  program?: string;
};

export type FieldRenderSitesView = {
  sites: FieldReadSite[];
  /** Reference set capped (§19) — unseen reads may render the field, so `renderedBy` is a lower
   *  bound. Absent when the whole set was inspected. */
  truncated?: { shown: number; total: number };
  /** Member references matched before the cap (every read/write site; counts, never display). */
  total: number;
};

/** Scan the member-read sites of the property symbol at `offset`. `undefined` mirrors the
 *  `findReferencesAcross === undefined` contract (no symbol resolves there). */
export function scanFieldRenderSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
): FieldRenderSitesView | undefined {
  const cross = findReferencesAcross(host, abs, offset, true);
  if (cross === undefined) return undefined;
  const multiProgram = host.programs().length > 1;
  const sites: FieldReadSite[] = [];
  const refs = cross.refs;
  const total = refs.length;
  const capped = total > SITE_CAP;
  const inspect = capped ? refs.slice(0, SITE_CAP) : refs;

  for (const ref of inspect) {
    const role = classifyRole(ref.sourceFile, ref.start, {
      isDefinition: ref.isDefinition,
      isWrite: ref.isWriteAccess,
    });
    // Harmless contexts — the decl itself, imports/re-exports, type positions — are not value reads
    // of the field; they never render it. (A property ref is never role 'jsx'/'jsx-closing'.)
    if (role === 'decl' || role === 'import' || role === 'reexport' || role === 'type') continue;

    const span = spanFromRange(ref.sourceFile, ref.rel, ref.start, ref.start + ref.length);
    const node = nodeAt(ref.sourceFile, ref.start);
    const kind = readKind(node, ref.isWriteAccess);
    const pos = classifyJsxPosition(ref.sourceFile, node);
    const enclosing = readEncloser(ref.sourceFile, ref.rel, ref.start);
    sites.push({
      span,
      jsx: pos.jsx,
      ...(pos.tag !== undefined ? { tag: pos.tag } : {}),
      kind,
      ...(enclosing !== undefined ? { enclosing } : {}),
      ...(multiProgram ? { program: ref.program } : {}),
    });
  }

  return {
    sites,
    ...(capped ? { truncated: { shown: SITE_CAP, total } } : {}),
    total,
  };
}

/** Build the enclosing-declaration address (the name-token span the op chains to `react.classify`). */
function readEncloser(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  start: number,
): FieldReadEncloser | undefined {
  const enc = findEncloser(sourceFile, start);
  if (enc === undefined) return undefined;
  return {
    name: enc.name,
    idName: enc.idName,
    kind: enc.kind,
    span: spanFromRange(sourceFile, rel, enc.start, enc.start + enc.idName.length),
    exported: enc.exported,
  };
}

/** A property reference that is the NAME of an object-binding element (`const {email}=u`,
 *  `const {email: e}=u` — the ref lands on the `email` property token) is a DESTRUCTURE: the field
 *  flows into a local whose downstream reads member-level references can no longer follow. */
function readKind(node: ts.Node | undefined, isWrite: boolean): FieldReadSite['kind'] {
  const parent = node?.parent;
  if (
    parent !== undefined &&
    ts.isBindingElement(parent) &&
    ts.isObjectBindingPattern(parent.parent)
  )
    return 'destructure';
  return isWrite ? 'write' : 'read';
}

/** The nearest enclosing JSX position of a read. Walks up to the first `JsxExpression` that wraps the
 *  read (bounded at a statement — an indirection through a block/callback local is NOT a direct render,
 *  honestly `none`), then reads its slot (child vs attribute) and the owning element's tag kind. */
function classifyJsxPosition(
  sourceFile: ts.SourceFile,
  node: ts.Node | undefined,
): { jsx: FieldReadJsx; tag?: string } {
  if (node === undefined) return { jsx: 'none' };
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (ts.isJsxExpression(up)) {
      const parent = up.parent;
      if (ts.isJsxElement(parent))
        return childSlot(
          elementTagKind(parent.openingElement.tagName),
          parent.openingElement.tagName,
          sourceFile,
        );
      if (ts.isJsxFragment(parent)) return { jsx: 'intrinsic-child' }; // a fragment renders children directly
      if (ts.isJsxAttribute(parent)) {
        const owner = parent.parent.parent; // JsxAttribute → JsxAttributes → opening/self-closing element
        if (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner))
          return attrSlot(elementTagKind(owner.tagName), owner.tagName, sourceFile);
      }
      return { jsx: 'none' }; // a JsxExpression in some other slot — be conservative
    }
    if (ts.isStatement(up)) break; // a render context never crosses a statement boundary
  }
  return { jsx: 'none' };
}

function childSlot(
  intrinsic: boolean,
  tagName: ts.JsxTagNameExpression,
  sourceFile: ts.SourceFile,
): { jsx: FieldReadJsx; tag: string } {
  return { jsx: intrinsic ? 'intrinsic-child' : 'value-child', tag: tagName.getText(sourceFile) };
}

function attrSlot(
  intrinsic: boolean,
  tagName: ts.JsxTagNameExpression,
  sourceFile: ts.SourceFile,
): { jsx: FieldReadJsx; tag: string } {
  return { jsx: intrinsic ? 'intrinsic-attr' : 'value-attr', tag: tagName.getText(sourceFile) };
}

/** TSX-language fact: a tag that is a lowercase-initial bare identifier is an INTRINSIC (host)
 *  element; an uppercase identifier, a qualified name (`Foo.Bar`, `motion.div`), or anything else is
 *  a VALUE-based element (a component). The conservative direction is value (under-counts
 *  `renderedBy`, never over-claims a render). */
function elementTagKind(tagName: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tagName)) return /^[a-z]/.test(tagName.text);
  return false;
}
