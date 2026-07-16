// A GENERIC scan of the members of a function's FIRST-parameter type (§5-L2) — the seam the
// `react` plugin consumes to read a component's DECLARED props. Domain-NEUTRAL: it knows nothing
// of "components" or "props"; it resolves the function-like declaration at the target, takes its
// first parameter, and lists the APPARENT-type properties of that parameter's type. The react
// CONVENTION ("the first parameter is props") lives in plugins/react, never here (§4).
//
// The type oracle is the live checker (§3.1). `getApparentType().getProperties()` is the checker's
// own member-merge, so `extends` and intersection (`A & B`) props fall out FLATTENED for free — the
// requirement a union/intersection-dispatching `expand_type` cannot meet (it would return arm type
// strings, not the merged member set). Each member carries its declaration-name span (proof, §3.1).

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import { elideType } from '../../common/truncate/elide-type.ts';
import type { TsProjectHost } from './ls-host.ts';
import { nodeAt } from './ast-node.ts';
import { spanFromRange } from './spans.ts';

/** Bound the member set (§19) — a props type is small, but an HTML-attribute intersection can
 *  carry hundreds; cap and report rather than emit an unbounded list. */
const MEMBER_CAP = 500;

export type ParamTypeMember = {
  name: string;
  optional: boolean;
  type: string;
  /** From a base/intersection type, not the parameter's own annotation (best-effort; absent when
   *  the owning type is anonymous so ownership can't be determined). */
  inherited?: boolean;
  /** Declaration-name span of the member (proof). Absent for a synthesized member with no node. */
  span?: Span;
};

export type ParamTypeMembersView = {
  members: ParamTypeMember[];
  /** The function-like declaration has no first parameter (nothing to declare). */
  noParam: boolean;
  /** Member set capped at `MEMBER_CAP` — `total` declared, `members.length` shown. */
  truncated?: { shown: number; total: number };
};

/** Members of the first parameter's type of the function at `offset`. `undefined` when no
 *  program/source resolves (mirrors the other reads); `noParam` when the function takes none. */
export function firstParamTypeMembers(
  host: TsProjectHost,
  abs: string,
  offset: number,
): ParamTypeMembersView | undefined {
  // Route the checker to the type-authority for `abs`: in a no-root repo `host.service` is the
  // fallback primary whose whole-repo glob pollutes the component's props type with augmentation
  // strays (t-593802). typeAuthorityFor returns the member's own-options program.
  const program = host.typeAuthorityFor(abs).getProgram();
  const sourceFile = program?.getSourceFile(abs);
  if (program === undefined || sourceFile === undefined) return undefined;
  const node = nodeAt(sourceFile, offset);
  if (node === undefined) return undefined;
  const param = firstParameterOf(node);
  if (param === undefined) return { members: [], noParam: true };

  const checker = program.getTypeChecker();
  const type = checker.getTypeAtLocation(param);
  const props = checker.getApparentType(type).getProperties();
  const ownDecls = new Set(type.getSymbol()?.declarations ?? []);
  const total = props.length;
  const shown = total > MEMBER_CAP ? props.slice(0, MEMBER_CAP) : props;
  const members = shown.map((prop) => buildMember(host, checker, prop, param, ownDecls));
  return {
    members,
    noParam: false,
    ...(total > MEMBER_CAP ? { truncated: { shown: MEMBER_CAP, total } } : {}),
  };
}

/** The first parameter of the function-like declaration enclosing (or initialized by) `node`.
 *  Handles `function f(p)`, methods, `const f = (p) => …` / `const f = function (p) {}`, and the
 *  call-wrapped form `const C = forwardRef((p, ref) => …)` (the inner function's first param). */
function firstParameterOf(node: ts.Node): ts.ParameterDeclaration | undefined {
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (
      ts.isFunctionDeclaration(up) ||
      ts.isFunctionExpression(up) ||
      ts.isArrowFunction(up) ||
      ts.isMethodDeclaration(up)
    ) {
      return up.parameters[0];
    }
    // The name token of `const C = (p) => …` resolves to the VariableDeclaration (the arrow is its
    // initializer sibling, not an ancestor of the name) — descend into the initializer's function.
    if (ts.isVariableDeclaration(up) && up.initializer !== undefined) {
      return functionOfInitializer(up.initializer)?.parameters[0];
    }
  }
  return undefined;
}

/** The function carried by a binding initializer — a direct arrow/function-expression, or the
 *  first such argument of a HOC call (`forwardRef`/`memo`/…). `undefined` for a non-function init. */
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

function buildMember(
  host: TsProjectHost,
  checker: ts.TypeChecker,
  prop: ts.Symbol,
  location: ts.Node,
  ownDecls: ReadonlySet<ts.Declaration>,
): ParamTypeMember {
  const propType = checker.getTypeOfSymbolAtLocation(prop, location);
  const member: ParamTypeMember = {
    name: prop.getName(),
    optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
    type: typeStr(checker, propType),
  };
  const decl = prop.declarations?.[0];
  const declParent = decl?.parent;
  // Only claim `inherited` when the owning type is named (ownDecls known); an anonymous
  // type-literal / intersection leaves ownership undetermined → omit rather than over-report.
  if (
    ownDecls.size > 0 &&
    declParent !== undefined &&
    !ownDecls.has(declParent as ts.Declaration)
  ) {
    member.inherited = true;
  }
  if (decl !== undefined) {
    const declSf = decl.getSourceFile();
    const nameNode = memberNameNode(decl);
    member.span = spanFromRange(
      declSf,
      host.relOf(declSf.fileName),
      nameNode.getStart(declSf),
      nameNode.getEnd(),
    );
  }
  return member;
}

/** The name token of a member declaration for a tight proof span, or the whole declaration
 *  when it has no simple name node. Shared with `member-usages.ts` (the member-decl → name-token
 *  offset both seams anchor references on). */
export function memberNameNode(decl: ts.Declaration): ts.Node {
  if (
    (ts.isPropertySignature(decl) ||
      ts.isPropertyDeclaration(decl) ||
      ts.isMethodSignature(decl) ||
      ts.isMethodDeclaration(decl)) &&
    decl.name !== undefined
  ) {
    return decl.name;
  }
  return decl;
}

/** `typeToString` with NoTruncation, then the `common/truncate` chokepoint (`first-param-member-type`
 *  `CapId`) — a silent checker `...` reads as completeness (§3.4). `length-only` marker: this op
 *  (`find_unused_props`) does not thread `verbosity:full`, so the cut reports the full length WITHOUT
 *  a bogus `verbosity:full` recovery. */
function typeStr(checker: ts.TypeChecker, type: ts.Type): string {
  return elideType(
    checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
    'first-param-member-type',
  );
}
