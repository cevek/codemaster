// Reference-site classification + enclosing-declaration rollup — pure AST work, no
// domain semantics. `role` says WHAT a reference syntactically is (`<X/>` vs `X()` vs
// a type position vs an import); `findEncloser` lifts a reference to its nearest
// enclosing NAMED declaration — the universal "which component/function uses X"
// answer, formulated as an AST concept.

import ts from 'typescript';
import { nodeAt } from './ast-node.ts';
import { qualifyMember } from './encloser-id.ts';
import { destructureRole } from './destructure-role.ts';

/** Syntactic role of one reference site. `decl` = the definition itself. `reexport` =
 *  an `export { X }` / `export { X } from …` barrel specifier — structurally load-bearing
 *  (the module's public surface), so it is never collapsed away like a plain `import`.
 *  `jsx-closing` is internal: the `</X>` half of an element already counted at its
 *  opening tag — consumers drop it so counts mean "JSX elements", not tag tokens. */
export type UsageRole = 'jsx' | 'call' | 'type' | 'import' | 'reexport' | 'write' | 'read' | 'decl';
export type ClassifiedRole = UsageRole | 'jsx-closing';

export const USAGE_ROLES = [
  'jsx',
  'call',
  'type',
  'import',
  'reexport',
  'write',
  'read',
  'decl',
] as const;

export function classifyRole(
  sourceFile: ts.SourceFile,
  position: number,
  flags: { isDefinition: boolean; isWrite: boolean },
): ClassifiedRole {
  if (flags.isDefinition) return 'decl';
  const node = nodeAt(sourceFile, position);
  if (node === undefined) return flags.isWrite ? 'write' : 'read';
  // A position ON the name token of a top-level value/type declaration IS that declaration —
  // `decl` — even when the LS did NOT flag it `isDefinition`. Anchoring find_usages at a re-export
  // alias (`export { X } from './y'`) resolves the target's OWN declaration with isDefinition:false
  // + isWriteAccess:true, which would otherwise fall through to the `write` fallback and present a
  // definition as a write (§3 — a wrong, proof-carrying label). The same decl resolved directly
  // arrives isDefinition:true (handled above); this makes the role resolution-path-independent.
  if (isTopLevelDeclarationName(node)) return 'decl';

  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    // A barrel specifier (`export { X }` / `export { X } from './y'`) is a re-export —
    // load-bearing module surface, kept distinct from `import` so it is never collapsed.
    if (ts.isExportSpecifier(up)) return 'reexport';
    if (
      ts.isImportDeclaration(up) ||
      ts.isImportSpecifier(up) ||
      ts.isImportClause(up) ||
      ts.isImportEqualsDeclaration(up)
    ) {
      return 'import';
    }
    if (ts.isJsxOpeningElement(up) || ts.isJsxSelfClosingElement(up)) {
      // Only the tag name itself is a 'jsx' usage; a reference inside an attribute
      // expression keeps its own role and falls through on a later ancestor.
      if (within(up.tagName, position)) return 'jsx';
    }
    if (ts.isJsxClosingElement(up) && within(up.tagName, position)) return 'jsx-closing';
    if (ts.isTypeNode(up) || ts.isHeritageClause(up) || ts.isTypeQueryNode(up)) return 'type';
    // A member-signature NAME inside an `interface`/type-literal (`m(): void`, `p: T`,
    // `get x(): T` / `set x(v)`) is a TYPE-level declaration, not a value read/write.
    // `findReferences` links such a signature to an implementing/structurally-matching
    // value symbol, so the occurrence arrives here with `isDefinition:false` and would
    // otherwise fall through to `read` — a spurious value-read that `impact` mistakes for
    // a dynamic-dispatch escape. It lives in a type position, so it is a `type` usage. A
    // COMPUTED name (`[expr]: T`) keeps its own role — `expr` is a genuine value read.
    // `MethodSignature`/`PropertySignature` only ever appear as type members; an
    // accessor SIGNATURE also has the value-context form (a class accessor), so it counts
    // only when its parent is an interface/type-literal — a class accessor stays decl/read.
    if (
      isTypeMemberSignature(up) &&
      !ts.isComputedPropertyName(up.name) &&
      within(up.name, position)
    ) {
      return 'type';
    }
    if ((ts.isCallExpression(up) || ts.isNewExpression(up)) && within(up.expression, position)) {
      return 'call';
    }
    if (ts.isStatement(up)) break; // role context never crosses a statement boundary
  }
  // A destructure token that PURELY reads a source member out (`const {email}=u`, or the key of
  // `({email: local}=u)`) is a `read`, though the LS marks it `isWriteAccess` — else the fallthrough
  // presents a READ as a `write` (§3 role mislabel). Only `member-read` reclassifies: a `local-write`
  // (the shorthand `({email}=u)` token, which is also the local write-target) keeps the LS write bit,
  // so a genuine local write is never fabricated into a read. `member_usages` reads the same verdict
  // through the shared classifier (a member query maps `local-write` → destructure). A reassignment
  // `u.email = x` is `none` → still `write` below (t-381844 discriminant preserved).
  if (destructureRole(node) === 'member-read') return 'read';
  return flags.isWrite ? 'write' : 'read';
}

/** `node` is the NAME identifier of a top-level value/type declaration
 *  (function/class/interface/type-alias/enum/namespace/variable) — the kinds a re-export alias
 *  resolves to. Deliberately restricted to these: a MEMBER decl (`Method`/`PropertyDeclaration`)
 *  is excluded so member-refs' value-access scan is untouched, and a genuine value READ that merely
 *  sits inside a declaration node (an object shorthand `{ x }`, a destructuring `BindingElement`) is
 *  NOT swept into `decl` — only the declaration's own name token matches (`getNameOfDeclaration`). */
function isTopLevelDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isModuleDeclaration(parent) ||
    ts.isVariableDeclaration(parent)
  ) {
    return ts.getNameOfDeclaration(parent) === node;
  }
  return false;
}

/** A NAMED member signature of an `interface`/type-literal — a TYPE-level member
 *  declaration, never a value binding. `MethodSignature`/`PropertySignature` are type
 *  members by construction (a class uses `MethodDeclaration`/`PropertyDeclaration`); an
 *  accessor signature also has a value-context form (a class `get`/`set`), so it counts
 *  only when its parent is the type context — a class accessor stays decl/read/write. */
function isTypeMemberSignature(
  node: ts.Node,
): node is
  | ts.MethodSignature
  | ts.PropertySignature
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  if (ts.isMethodSignature(node) || ts.isPropertySignature(node)) return true;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return ts.isInterfaceDeclaration(node.parent) || ts.isTypeLiteralNode(node.parent);
  }
  return false;
}

export interface Encloser {
  /** Display name — qualified `Class.method` for a class member, the bare name otherwise.
   *  NEVER the source of the SymbolId (that is `idName`); a qualified display minted as an
   *  id resolves `gone` (§6, see `encloser-id.ts`). */
  name: string;
  /** The BARE name-token text the SymbolId anchors on — equals the identifier at `start`, so
   *  the §6 same-symbol check holds. Equals `name` except for a class member (`make` vs the
   *  display `Class.make`). */
  idName: string;
  /** `const`/`variable` = a top-level non-function value binding (`const b = a()`,
   *  `let cfg = {…}`) — distinct from `function` so a data binding never reads as
   *  callable. A function-valued binding (incl. a HOC/tagged-template-wrapped one) stays
   *  `function`. */
  kind: 'function' | 'method' | 'class' | 'module' | 'const' | 'variable';
  /** Start of the encloser's name token (the `idName` identifier). */
  start: number;
  exported: boolean;
}

/** Nearest enclosing named declaration of a position; `undefined` → module top level
 *  (the caller groups those under the file itself). */
export function findEncloser(sourceFile: ts.SourceFile, position: number): Encloser | undefined {
  const node = nodeAt(sourceFile, position);
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (ts.isFunctionDeclaration(up) && up.name !== undefined) {
      return encloser(up.name.text, up.name.text, 'function', up.name, up);
    }
    if (ts.isMethodDeclaration(up) && ts.isIdentifier(up.name)) {
      // Display name qualifies (`Class.method`); the id anchors on the bare `method` token
      // (`up.name`), so the handle chains (§6 / `encloser-id.ts`).
      return encloser(qualifyMember(up.parent, up.name.text), up.name.text, 'method', up.name, up);
    }
    // A FUNCTION-valued class field (`handler = () => …`, a React arrow component method, or a
    // HOC/styled-wrapped one) is a member encloser exactly like a `MethodDeclaration` — display
    // `Class.prop`, id on the bare `prop` token. Bug 1's scope is "class-method/property
    // encloser"; without this a ref inside the field rolls up to the CLASS, a coarser handle. A
    // plain-VALUE class field stays rolled to the class (no member-level `kind` to mint for it).
    if (
      ts.isPropertyDeclaration(up) &&
      ts.isIdentifier(up.name) &&
      isFunctionValued(up.initializer)
    ) {
      return encloser(qualifyMember(up.parent, up.name.text), up.name.text, 'method', up.name, up);
    }
    if (ts.isClassDeclaration(up) && up.name !== undefined && !within(up.name, position)) {
      return encloser(up.name.text, up.name.text, 'class', up.name, up);
    }
    if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) {
      // ONLY a MODULE-SCOPE binding (a `SourceFile`/`ModuleBlock` boundary) is a useful,
      // robustly re-resolvable encloser. A nested LOCAL binding — value OR function-valued —
      // belongs to its enclosing function/method, so we keep walking up. Gating BOTH cases is
      // load-bearing: a function-valued LOCAL (`const cb = useCallback(() => dep(), [dep])`, or
      // any HOC/tagged-template-wrapped local) must NOT divert `dep` off its enclosing function
      // onto the fragile local handle `cb` — that would HIDE the real function under a
      // `kind:'function'` view, the very under-report bug 2 set out to fix.
      const statement = moduleScopeVariableStatement(up);
      if (statement !== undefined) {
        const initializer = up.initializer;
        // A reference INSIDE a function-valued binding's body belongs to that function —
        // `const Foo = () => …`, or a HOC/tagged-template-wrapped one (`const Foo = memo(() =>
        // …)`, `const Box = styled.div\`…\``). The binding's own name/decl ref is NOT inside the
        // initializer, so it falls through to the module rollup (unchanged). Exported-ness lives
        // on the VariableStatement.
        if (
          isFunctionValued(initializer) &&
          initializer !== undefined &&
          within(initializer, position)
        ) {
          return encloser(up.name.text, up.name.text, 'function', up.name, statement);
        }
        // Otherwise a MODULE-SCOPE non-function value binding (`export const b = a()`,
        // `const cfg = { f: dep }`) is its own encloser → a reference in its initializer rolls up
        // to a re-resolvable `name@file:line:col` SymbolId instead of the module node.
        if (!isFunctionValued(initializer)) {
          const kind = isConst(statement) ? 'const' : 'variable';
          return encloser(up.name.text, up.name.text, kind, up.name, statement);
        }
      }
    }
  }
  return undefined;
}

/** The `VariableStatement` of `decl` iff it sits at a module boundary — its parent is the
 *  `SourceFile` OR a `ModuleBlock` (`namespace N { … }` / `module M { … }`). Such a binding
 *  is re-resolvable by name, so it is its own encloser instead of dead-ending in the module
 *  rollup (the pre-Task-H top-level bug, here extended to namespace members). `undefined` for
 *  a function/block-local binding or a `for (const …)` head (parent is the loop, not a
 *  VariableStatement) — those belong to the enclosing function/method, not themselves. */
function moduleScopeVariableStatement(
  decl: ts.VariableDeclaration,
): ts.VariableStatement | undefined {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement)) return undefined;
  const parent = statement.parent;
  return ts.isSourceFile(parent) || ts.isModuleBlock(parent) ? statement : undefined;
}

/** A binding initializer that makes the binding renderable/callable — kinded `function` so a
 *  `kind:'function'` view never SKIPS it (the under-report bug 2 closes). Direct
 *  arrow/function-expression; a HOC wrapper (`memo(() => …)`, `forwardRef(…)`,
 *  `observer(…)`, `React.memo(…)`) whose call carries an arrow/fn-expr argument; or a tagged
 *  template (`styled.div\`…\``). The trigger is deliberately broad (any call with a callback
 *  argument, no HOC name allowlist) so it catches `React.memo`, `styled(...)`, and
 *  `forwardRef<T>(…)` for free — at the cost of labelling a value-returning callback wrapper
 *  (`useMemo(() => v, [])`, `arr.map(fn)` bound to a const) `function` too. That over-label is
 *  the spec's intended breadth: under-reporting a real component/hook is the worse direction. */
function isFunctionValued(init: ts.Expression | undefined): boolean {
  if (init === undefined) return false;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return true;
  if (ts.isTaggedTemplateExpression(init)) return true;
  if (ts.isCallExpression(init)) {
    return init.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
  }
  return false;
}

function isConst(statement: ts.VariableStatement): boolean {
  return (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function encloser(
  name: string,
  idName: string,
  kind: Encloser['kind'],
  nameNode: ts.Node,
  declaration: ts.Node,
): Encloser {
  return { name, idName, kind, start: nameNode.getStart(), exported: isExported(declaration) };
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function within(node: ts.Node, position: number): boolean {
  return node.getStart() <= position && position < node.getEnd();
}
