// The shared member-reference CORE (§5-L2): one `findReferencesAcross` pass over a PROPERTY symbol's
// declaration → its member-access sites, each classified read / write / DESTRUCTURE with its enclosing
// declaration + program. Member-level BY CONSTRUCTION — references of a property symbol are exactly its
// `obj.email` accesses (alias-safe), never any same-named `email` on an unrelated type (§3.1 identity).
//
// Two consumers ride this one primitive so they can never disagree (§3): `field-render-sites.ts`
// (adds the TSX render-position fact for `trace_field_to_render`) and `member-usages.ts` (the
// `member_usages` op's read/write disposition). Extracted so the read/write/destructure classification
// lives ONCE — a parallel classifier would re-introduce the destructure-as-`write` mislabel a
// syntactic role check makes. The `node`/`sourceFile` handles are retained on each ref for a consumer's
// further per-site classification; the clean view types stay in each consumer.

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

/** A member reference's disposition. `destructure` = a `const {email}=u` binding whose downstream
 *  local reads are INVISIBLE to member-level references (the honesty floor); a plain `read`; an
 *  assignment `write` (`u.email = x`). */
export type MemberRefKind = 'read' | 'write' | 'destructure';

/** The enclosing named declaration of a reference — a chainable address + proof span. `undefined`
 *  → the reference sits at module top level. */
export type MemberRefEncloser = {
  name: string;
  idName: string;
  kind: string;
  span: Span;
  exported: boolean;
};

/** One classified member reference. `span`/`kind`/`enclosing`/`program` are the clean facts every
 *  consumer surfaces; `sourceFile`/`node`/`start`/`rel` are retained for a consumer's own per-site
 *  classification (e.g. field-render-sites' JSX position) — plugin-internal, never leaked to a view. */
export type MemberRef = {
  span: Span;
  kind: MemberRefKind;
  enclosing?: MemberRefEncloser;
  /** Populated only in a multi-program repo (Task G) — the program that surfaced this ref. */
  program?: string;
  sourceFile: ts.SourceFile;
  node: ts.Node | undefined;
  start: number;
  rel: RepoRelPath;
};

export type MemberRefsScan = {
  refs: MemberRef[];
  /** Reference set capped (§19) — unseen sites exist, so the result is a lower bound. Absent when
   *  the whole set was inspected. */
  truncated?: { shown: number; total: number };
  /** Raw references matched (incl. the decl/import/type positions filtered out of `refs`); a count,
   *  never display. */
  total: number;
};

/** Scan the member-reference sites of the property symbol at `offset`. `undefined` mirrors the
 *  `findReferencesAcross === undefined` contract (no symbol resolves there). Harmless contexts — the
 *  declaration itself, imports/re-exports, type positions — are dropped: they are not value accesses
 *  of the member. */
export function scanMemberRefs(
  host: TsProjectHost,
  abs: string,
  offset: number,
): MemberRefsScan | undefined {
  const cross = findReferencesAcross(host, abs, offset, true);
  if (cross === undefined) return undefined;
  const multiProgram = host.programs().length > 1;
  const refs: MemberRef[] = [];
  const total = cross.refs.length;
  const capped = total > SITE_CAP;
  const inspect = capped ? cross.refs.slice(0, SITE_CAP) : cross.refs;

  for (const ref of inspect) {
    const role = classifyRole(ref.sourceFile, ref.start, {
      isDefinition: ref.isDefinition,
      isWrite: ref.isWriteAccess,
    });
    // Not a value access of the field — the decl, imports/re-exports, type positions. (A property
    // ref is never role 'jsx'/'jsx-closing'.)
    if (role === 'decl' || role === 'import' || role === 'reexport' || role === 'type') continue;

    const node = nodeAt(ref.sourceFile, ref.start);
    const enclosing = memberRefEncloser(ref.sourceFile, ref.rel, ref.start);
    refs.push({
      span: spanFromRange(ref.sourceFile, ref.rel, ref.start, ref.start + ref.length),
      kind: memberRefKind(node, ref.isWriteAccess),
      ...(enclosing !== undefined ? { enclosing } : {}),
      ...(multiProgram ? { program: ref.program } : {}),
      sourceFile: ref.sourceFile,
      node,
      start: ref.start,
      rel: ref.rel,
    });
  }

  return { refs, ...(capped ? { truncated: { shown: SITE_CAP, total } } : {}), total };
}

/** A property reference that reads the field OUT into a local via a destructuring pattern is a
 *  DESTRUCTURE — the field flows into a local whose downstream reads member-level references can no
 *  longer follow. Two syntactic forms: a BINDING-pattern destructure (`const {email}=u`,
 *  `const {email: e}=u` — the ref lands on the `email` property token in an ObjectBindingPattern), and
 *  an ASSIGNMENT destructure (`({email}=u)` — the token sits in a ShorthandPropertyAssignment/
 *  PropertyAssignment of an ObjectLiteralExpression that is the LHS of `=`, which the LS otherwise
 *  reports as a write of the OBJECT). Both must classify `destructure`, not `write`, or the
 *  downstream-invisible floor goes undisclosed. Else the LS write-access bit decides read vs write. */
export function memberRefKind(node: ts.Node | undefined, isWrite: boolean): MemberRefKind {
  const parent = node?.parent;
  if (
    parent !== undefined &&
    ts.isBindingElement(parent) &&
    ts.isObjectBindingPattern(parent.parent)
  )
    return 'destructure';
  if (node !== undefined && isAssignmentDestructureTarget(node)) return 'destructure';
  return isWrite ? 'write' : 'read';
}

/** True when `node` (a property-name token) sits in an ASSIGNMENT destructure — a
 *  Shorthand/PropertyAssignment inside an ObjectLiteralExpression that is (through parens) the LEFT
 *  side of an `=`. This reads the member out into a local, not a write of the member. */
function isAssignmentDestructureTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    parent === undefined ||
    !(ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent))
  )
    return false;
  const obj = parent.parent;
  if (!ts.isObjectLiteralExpression(obj)) return false;
  let up: ts.Node = obj;
  while (up.parent !== undefined && ts.isParenthesizedExpression(up.parent)) up = up.parent;
  const bin = up.parent;
  return (
    bin !== undefined &&
    ts.isBinaryExpression(bin) &&
    bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    bin.left === up
  );
}

/** Build the enclosing-declaration address (the name-token span a consumer chains onward). */
export function memberRefEncloser(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  start: number,
): MemberRefEncloser | undefined {
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
