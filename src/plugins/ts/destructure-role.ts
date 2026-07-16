// The shared destructure-token classifier (§3 — one oracle, no parallel classifier). A property-name
// token that a destructuring pattern reads OUT into a local is a READ of the source member, even
// though the LS marks the pattern token `isWriteAccess`. Both role classifiers ride this one function
// so they can never disagree — but they map its verdict into DIFFERENT domains, because the same token
// can mean different things depending on which SYMBOL was queried (member vs local):
//   · `memberRefKind` (member_usages) is ALWAYS a member query → any destructure token reads the
//     member out → `destructure`.
//   · `classifyRole` (find_usages) is a GENERAL query → it may target the LOCAL a destructure writes,
//     so it must NOT fabricate a `read` for a genuine local write (§3).
// Hence the 3-way verdict below rather than a bare boolean.

import ts from 'typescript';

/** How a token participates in a destructuring pattern:
 *  · `member-read`  — it reads the source member OUT and is NOT itself a local write-target
 *    (a binding-pattern property token, or the property-NAME key of `({email: local}=u)`). Pure read.
 *  · `local-write`  — a shorthand assignment token `({email}=u)`: the ONE identifier is simultaneously
 *    the member key (read out) AND the local write-target. A member query still reads it out; a
 *    general/local query must treat it as the write it also is — so the verdict names the write.
 *  · `none`         — not a destructure member token (the value token of `({email: local}=u)`, a plain
 *    `x.foo`, an array pattern, …); the caller's own read/write bit decides. */
export type DestructureRole = 'member-read' | 'local-write' | 'none';

export function destructureRole(node: ts.Node | undefined): DestructureRole {
  const parent = node?.parent;
  if (parent === undefined || node === undefined) return 'none';
  // BINDING destructure (`const {email}=u`, `const {email: e}=u`): a token on the property side of an
  // ObjectBindingPattern reads the member out. The local binding is the DECLARATION (isDefinition →
  // `decl`, handled by the caller before this runs), so a non-decl ref reaching here is a pure member
  // read — never a local write-target, so `member-read` is unambiguous even for the shorthand form.
  if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)) return 'member-read';
  return assignmentDestructureRole(node, parent);
}

/** The verdict for an ASSIGNMENT destructure `(…)=obj`. The value token of `{email: local}` is a plain
 *  local write (`none` — parent.name !== node); the property-NAME key is a pure `member-read`; the
 *  shorthand `{email}` token is the dual-role `local-write`. Anything not in an assignment-LHS object
 *  literal is `none`. */
function assignmentDestructureRole(node: ts.Node, parent: ts.Node): DestructureRole {
  const isShorthand = ts.isShorthandPropertyAssignment(parent);
  const isProp = ts.isPropertyAssignment(parent);
  if (!isShorthand && !isProp) return 'none';
  if (isProp && parent.name !== node) return 'none'; // the value token = the local write, not a read
  if (!inAssignmentLhsObject(parent)) return 'none';
  return isShorthand ? 'local-write' : 'member-read';
}

/** True when `assignment` (a Shorthand/PropertyAssignment) sits in an ObjectLiteralExpression that is
 *  (through parens) the LEFT side of an `=` — an assignment-destructure target, not an object value. */
function inAssignmentLhsObject(assignment: ts.Node): boolean {
  const obj = assignment.parent;
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
