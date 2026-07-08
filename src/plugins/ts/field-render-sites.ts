// A GENERIC syntactic projection of a property symbol's member-read sites, each tagged with the
// TSX-language fact that decides "is this a render?": the nearest enclosing JSX position
// (intrinsic-host element vs value-based element, child vs attribute). The seam `trace_field_to_render`
// consumes to answer "which components render `User.email`" (§17 Phase 6).
//
// It rides the shared `scanMemberRefs` CORE (member-refs.ts) — ONE `findReferencesAcross` pass over
// the property symbol (alias-safe, member-level by construction: references of the PROPERTY symbol are
// exactly the `obj.email` accesses, not any `email`), read/write/DESTRUCTURE already classified there
// so `member_usages` and this seam can never disagree (§3). Per ref it adds ONLY the JSX-position fact.
//
// DOMAIN-NEUTRAL (§4): the intrinsic-vs-value distinction is a TSX-language fact (TS itself splits
// `IntrinsicElements` from value-based elements by tag capitalization), NOT a react convention. The
// MEANING ("intrinsic → the enclosing component renders it; value → it is passed to a child component")
// is the op's interpretation, applied above this seam. HONESTY: member-level references DO NOT see a
// computed `obj[k]`, a spread `{...obj}`, or a destructured local's downstream reads — a destructure
// binding is FLAGGED (`kind:'destructure'`) so the op never counts it as a proven render; the rest is
// the op's stated floor. Bounded: the reference set is hard-capped (§19) and the cap reported.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import type { TsProjectHost } from './ls-host.ts';
import { scanMemberRefs, type MemberRefEncloser } from './member-refs.ts';

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
 *  to decide component/hook. The shared member-ref encloser (member-refs.ts). */
export type FieldReadEncloser = MemberRefEncloser;

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
 *  `scanMemberRefs === undefined` contract (no symbol resolves there). Rides the shared member-ref
 *  core (read/write/destructure + enclosing + program already classified) and adds ONLY the
 *  JSX-position fact per site. */
export function scanFieldRenderSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
): FieldRenderSitesView | undefined {
  const scan = scanMemberRefs(host, abs, offset);
  if (scan === undefined) return undefined;
  const sites: FieldReadSite[] = scan.refs.map((ref) => {
    const pos = classifyJsxPosition(ref.sourceFile, ref.node);
    return {
      span: ref.span,
      jsx: pos.jsx,
      ...(pos.tag !== undefined ? { tag: pos.tag } : {}),
      kind: ref.kind,
      ...(ref.enclosing !== undefined ? { enclosing: ref.enclosing } : {}),
      ...(ref.program !== undefined ? { program: ref.program } : {}),
    };
  });
  return {
    sites,
    ...(scan.truncated !== undefined ? { truncated: scan.truncated } : {}),
    total: scan.total,
  };
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
