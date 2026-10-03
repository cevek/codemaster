// Reshapes the LS "Move to file" edits for a consumer that reaches the moved symbol through a
// namespace import (`import * as M from '<source>'` + `M.moved(…)`). TS (`updateNamespaceLikeImport`,
// 6.0.3) handles that consumer by inserting `import * as <preferred> from '<dest>'` and repointing the
// `M` of each moved ref — with two defects:
//   - when `<preferred>` is taken at a ref site the refs get `getUniqueName` (`<preferred>_1`) while
//     the inserted import keeps `<preferred>`, so import and refs never agree;
//   - a namespace import of the dest the consumer ALREADY has is never reused, so every move into one
//     dest stacks another import (a `transaction` chain into one module fails on step 2).
// Fixed at the edit level, before the edits are applied: only there are the LS-rewritten identifiers
// distinguishable from user code, and only the pre-edit checker can tell whether an existing alias is
// shadowed at a ref site. `import X = require` / `const X = require` forms of the same path: t-132219.

import ts from 'typescript';
import { toPosix } from '../../../../support/fs/canonicalize.ts';

interface Insertion {
  change: ts.TextChange;
  name: string;
  nameStart: number; // offset of the namespace binding inside `change.newText`
}

/** `program` must be the one the LS computed `changes` against (its consumer texts carry the edit
 *  offsets); `destAbs` is the move/extract target. Files with nothing to reconcile pass through as the
 *  same object. */
export function reconcileNamespaceImports(
  program: ts.Program,
  changes: readonly ts.FileTextChanges[],
  destAbs: string,
): ts.FileTextChanges[] {
  const dest = toPosix(destAbs);
  return changes.map((fc) => {
    if (fc.isNewFile === true || toPosix(fc.fileName) === dest) return fc;
    const sf = program.getSourceFile(fc.fileName);
    return sf === undefined ? fc : reconcileFile(fc, sf, program, destAbs);
  });
}

function reconcileFile(
  fc: ts.FileTextChanges,
  sf: ts.SourceFile,
  program: ts.Program,
  destAbs: string,
): ts.FileTextChanges {
  const insertions = fc.textChanges.flatMap((c) => {
    const ins = namespaceInsertion(c);
    return ins === undefined ? [] : [ins];
  });
  // Two source namespace imports in one file give two same-named insertions; merging them is a
  // design of its own — leave the LS output for the gate to judge.
  const ins = insertions[0];
  if (ins === undefined || insertions.length !== 1) return fc;

  const refName = new RegExp(`^${escapeRe(ins.name)}(_\\d+)?$`);
  const refs = new Map<ts.TextChange, ts.Identifier>();
  for (const c of fc.textChanges) {
    if (c.span.length === 0 || !refName.test(c.newText)) continue;
    const id = namespaceQualifierAt(sf, c.span.start, c.span.start + c.span.length);
    if (id !== undefined) refs.set(c, id);
  }
  const refNames = new Set([...refs.keys()].map((c) => c.newText));
  const [used] = refNames;
  if (used === undefined || refNames.size !== 1) return fc;

  const reuse = reusableAlias(sf, program, destAbs, [...refs.values()]);
  if (reuse !== undefined) {
    return {
      ...fc,
      textChanges: fc.textChanges
        .filter((c) => c !== ins.change)
        .map((c) => (refs.has(c) ? { ...c, newText: reuse } : c)),
    };
  }
  if (used === ins.name) return fc;
  const renamed =
    ins.change.newText.slice(0, ins.nameStart) +
    used +
    ins.change.newText.slice(ins.nameStart + ins.name.length);
  return {
    ...fc,
    textChanges: fc.textChanges.map((c) => (c === ins.change ? { ...c, newText: renamed } : c)),
  };
}

/** A pure insertion whose text is exactly one value `import * as X from '…'`. */
function namespaceInsertion(c: ts.TextChange): Insertion | undefined {
  if (c.span.length !== 0) return undefined;
  const parsed = ts.createSourceFile('__ins__.ts', c.newText, ts.ScriptTarget.Latest, true);
  const [stmt, ...rest] = parsed.statements;
  if (stmt === undefined || rest.length > 0 || !ts.isImportDeclaration(stmt)) return undefined;
  const clause = stmt.importClause;
  const bindings = clause?.namedBindings;
  if (clause === undefined || clause.isTypeOnly || clause.name !== undefined) return undefined;
  if (bindings === undefined || !ts.isNamespaceImport(bindings)) return undefined;
  return { change: c, name: bindings.name.text, nameStart: bindings.name.getStart(parsed) };
}

/** The identifier spanning exactly [start,end) when it is the qualifier of a property access
 *  (`M` in `M.x`) — the shape `updateNamespaceLikeImport` rewrites. */
function namespaceQualifierAt(
  sf: ts.SourceFile,
  start: number,
  end: number,
): ts.Identifier | undefined {
  let node: ts.Node = sf;
  for (;;) {
    const child: ts.Node | undefined = node.forEachChild((n) =>
      n.getStart(sf) <= start && end <= n.getEnd() ? n : undefined,
    );
    if (child === undefined) break;
    node = child;
  }
  if (!ts.isIdentifier(node) || node.getStart(sf) !== start || node.getEnd() !== end)
    return undefined;
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.expression === node ? node : undefined;
}

/** The local name of an existing value namespace import of `dest` that every ref site resolves to
 *  (not shadowed), else undefined. */
function reusableAlias(
  sf: ts.SourceFile,
  program: ts.Program,
  destAbs: string,
  refs: readonly ts.Identifier[],
): string | undefined {
  // An extract's dest is not in the program yet — nothing to reuse, and no checker to build.
  const destSf = program.getSourceFile(destAbs);
  if (destSf === undefined) return undefined;
  const checker = program.getTypeChecker();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    const bindings = clause?.namedBindings;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (bindings === undefined || !ts.isNamespaceImport(bindings)) continue;
    const decls = checker.getSymbolAtLocation(stmt.moduleSpecifier)?.declarations;
    if (decls?.includes(destSf) !== true) continue;
    const alias = checker.getSymbolAtLocation(bindings.name);
    const name = bindings.name.text;
    if (alias === undefined) continue;
    const meaning = ts.SymbolFlags.Value | ts.SymbolFlags.Namespace;
    if (refs.every((r) => checker.resolveName(name, r, meaning, false) === alias)) return name;
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[$]/g, '\\$');
}
