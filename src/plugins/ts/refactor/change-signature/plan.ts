// change_signature (§7) — net-new on the LS (no front-renamer prior art). v1 supports two
// well-defined positional-parameter operations: REMOVE a parameter by index, and REORDER
// parameters by a permutation — applied to the declaration AND every call site found via the
// LS reference set. The transform is purely syntactic (reorder/drop the param + arg lists).
//
// TWO safety layers, because the §2.8 cold-tsc gate is TYPE-BLIND (a same-typed mis-bind
// compiles clean): (1) a CONSERVATIVE pre-check refuses the whole op on any reference we
// can't faithfully rewrite — a non-call value use, a spread arg, a reorder over an
// under-supplied call, or a call outside the tracked tree; (2) the post-edit typecheck then
// catches anything type-incompatible. A clean refusal beats a silent corruption (truth > speed).

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';
import type { RefactorPlan } from '../plan.ts';
import { assemblePlan } from '../imports/assemble.ts';
import { findReferencesAcross } from '../../cross-program.ts';

/** A call-site reference resolved against the program that surfaced it — so a `test/**` call
 *  under a sibling tsconfig carries its own SourceFile (the primary program lacks it). */
interface SigRef {
  fileName: string;
  start: number;
  sourceFile: ts.SourceFile;
}

/** Every reference to the callable at `sourceAbs:offset`. Cross-program (Task G for WRITES) so a
 *  `test/**` call site is rewritten too; primary-only on the transaction path (`crossProgram`
 *  false), where a sibling reading stale disk under a planning overlay would be unsound. */
function gatherSigRefs(
  host: TsProjectHost,
  sourceAbs: string,
  offset: number,
  crossProgram: boolean,
): SigRef[] {
  if (crossProgram) {
    return (findReferencesAcross(host, sourceAbs, offset)?.refs ?? []).map((r) => ({
      fileName: r.fileName,
      start: r.start,
      sourceFile: r.sourceFile,
    }));
  }
  const program = host.service.getProgram();
  const out: SigRef[] = [];
  for (const sym of host.service.findReferences(sourceAbs, offset) ?? []) {
    for (const ref of sym.references) {
      const sf = program?.getSourceFile(ref.fileName);
      if (sf !== undefined)
        out.push({ fileName: ref.fileName, start: ref.textSpan.start, sourceFile: sf });
    }
  }
  return out;
}

export interface SignatureChange {
  removeParam?: number;
  reorder?: readonly number[];
}

/** The function-like declaration whose name identifier starts exactly at `offset`. */
function callableAt(sf: ts.SourceFile, offset: number): ts.SignatureDeclaration | undefined {
  let found: ts.SignatureDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (found !== undefined) return;
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name !== undefined &&
      n.name.getStart(sf) === offset
    ) {
      found = n;
      return;
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.getStart(sf) === offset &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      found = n.initializer;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Lowest token at `pos`. */
function tokenAt(sf: ts.SourceFile, pos: number): ts.Node {
  const find = (node: ts.Node): ts.Node => {
    for (const child of node.getChildren(sf)) {
      if (child.getStart(sf) <= pos && pos < child.getEnd()) {
        return child.getChildCount(sf) > 0 ? find(child) : child;
      }
    }
    return node;
  };
  return find(sf);
}

/** The CallExpression whose callee tail identifier is `node` (handles `obj.method(…)`). */
function callOf(node: ts.Node): ts.CallExpression | undefined {
  let e: ts.Node = node;
  while (e.parent !== undefined && ts.isPropertyAccessExpression(e.parent) && e.parent.name === e) {
    e = e.parent;
  }
  if (e.parent !== undefined && ts.isCallExpression(e.parent) && e.parent.expression === e) {
    return e.parent;
  }
  return undefined;
}

/** True if an expression subtree may carry a side effect (a call / new / await / yield / tagged
 *  template / delete / assignment / `++` / `--`). Dropping such an argument on `removeParam` is a
 *  gate-invisible behavior change — the §2.8 cold-tsc gate stays clean — so we WARN (naming the
 *  site), rather than silently delete user code (§3.6: state what you couldn't guarantee). */
function mayHaveSideEffect(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isYieldExpression(n) ||
      ts.isTaggedTemplateExpression(n) ||
      ts.isDeleteExpression(n) ||
      (ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Source indices in their new order: removeParam drops one, reorder is the permutation. */
function resolveOrder(count: number, change: SignatureChange): number[] | string {
  if (change.reorder !== undefined) {
    const order = [...change.reorder];
    const sorted = [...order].sort((a, b) => a - b);
    if (sorted.length !== count || sorted.some((v, i) => v !== i)) {
      return `reorder must be a permutation of [0..${count - 1}]`;
    }
    return order;
  }
  if (change.removeParam !== undefined) {
    if (change.removeParam < 0 || change.removeParam >= count) {
      return `removeParam ${change.removeParam} is out of range (0..${count - 1})`;
    }
    return Array.from({ length: count }, (_, i) => i).filter((i) => i !== change.removeParam);
  }
  return 'pass removeParam (index) or reorder (permutation)';
}

/** Replace a `(...)` element list (params or args) with its elements in `order` — indices
 *  past the present element count (omitted optional args) are dropped. */
function listEdit(
  sf: ts.SourceFile,
  list: ts.NodeArray<ts.Node>,
  order: readonly number[],
): TextEdit {
  const text = order
    .filter((i) => i < list.length)
    .map((i) => list[i]?.getText(sf) ?? '')
    .join(', ');
  return { start: list.pos, end: list.end, text };
}

export function planChangeSignature(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  sourceAbs: string,
  offset: number,
  change: SignatureChange,
  /** Fan the call-site search across every program (default) so a `test/**` call is rewritten
   *  too; `false` on the transaction path (planning-overlay stale-sibling hazard, ls-host TRAP). */
  crossProgram = true,
): RefactorPlan | string {
  const program = host.service.getProgram();
  const sf = program?.getSourceFile(sourceAbs);
  if (sf === undefined) return 'source file not in the TS project';
  // SourceFile per touched file (decl + each ref) — a cross-program ref's text lives only in its
  // own program, so the apply step reads `before` from here, not a primary-only `getSourceFile`.
  const sfByFile = new Map<string, ts.SourceFile>([[sourceAbs, sf]]);
  const decl = callableAt(sf, offset);
  if (decl === undefined) return 'no function/method declaration at the target position';
  // Declaration-shape guards that apply to BOTH ops (the removeParam counterpart of the
  // reorder count-guard below): a `this` parameter occupies declaration slot 0 but NO argument
  // slot, and a rest parameter spans an unknown number of arguments — in either case the
  // declaration-index order cannot be applied to a call's arguments without a same-typed,
  // gate-invisible mis-bind (the §2.8 cold-tsc gate is type-blind). Refuse up front (truth >
  // speed) rather than silently corrupt — the reorder count-guard only covered its own path.
  const params = decl.parameters;
  if (
    params[0] !== undefined &&
    ts.isIdentifier(params[0].name) &&
    params[0].name.text === 'this'
  ) {
    return 'change_signature cannot safely rewrite a function with a `this` parameter (declaration and argument indices differ) — refusing';
  }
  if (params.some((p) => p.dotDotDotToken !== undefined)) {
    return 'change_signature cannot safely rewrite a function with a rest parameter (one parameter spans an unknown number of arguments) — refusing';
  }
  // An OVERLOADED function has multiple signature declarations; editing one (or the impl)
  // leaves the others — and every call site, which typechecks against their union — mismatched,
  // a same-typed mis-bind the §2.8 gate can miss. We rewrite a single signature; refuse with a
  // clear reason rather than let a downstream TS2554 surface as an opaque post-typecheck error.
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
    const sym =
      decl.name !== undefined
        ? program?.getTypeChecker().getSymbolAtLocation(decl.name)
        : undefined;
    const sigs = (sym?.declarations ?? []).filter(
      (d) => ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d),
    );
    if (sigs.length > 1) {
      return 'change_signature cannot safely rewrite an overloaded function (multiple signatures) — refusing; edit a single-signature function';
    }
  }
  const order = resolveOrder(decl.parameters.length, change);
  if (typeof order === 'string') return order;

  const isReorder = change.reorder !== undefined;
  const paramCount = decl.parameters.length;

  // Group edits by file: the declaration's parameter list + every call site's argument list.
  // CONSERVATIVE — refuse the WHOLE op (truth > speed) on any reference we cannot faithfully
  // rewrite, because the §2.8 cold-tsc gate is type-blind and would pass a same-typed mis-bind
  // silently. Blockers: a non-call VALUE use (the symbol passed/aliased/`new`/JSX — its call
  // expects the old signature and we can't reach it); a SPREAD arg (positions are unknown); a
  // reorder over a call that OMITS trailing args (the permutation isn't representable); a call
  // in a file outside the tracked tree (we'd never typecheck it). A clean refusal beats a
  // silent corruption.
  const editsByFile = new Map<string, TextEdit[]>();
  const push = (fileName: string, edit: TextEdit): void => {
    const list = editsByFile.get(fileName) ?? [];
    list.push(edit);
    editsByFile.set(fileName, list);
  };
  push(sourceAbs, listEdit(sf, decl.parameters, order));

  const blockers: string[] = [];
  // removeParam can drop a side-effecting argument expression that compiles clean (gate-blind) —
  // we don't refuse (the removal IS the request), but we surface a proof-carrying warning per site.
  const sideEffectNotes: string[] = [];
  const refs = gatherSigRefs(host, sourceAbs, offset, crossProgram);
  for (const ref of refs) {
    if (ref.fileName === sourceAbs && ref.start === offset) continue; // the decl name
    const refSf = ref.sourceFile;
    sfByFile.set(ref.fileName, refSf);
    const node = tokenAt(refSf, ref.start);
    const at = `${host.relOf(ref.fileName)}`;
    const parent = node.parent;
    if (
      parent !== undefined &&
      (ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent))
    ) {
      continue; // a re-export / import binding — the signature change doesn't touch it
    }
    const call = callOf(node);
    if (call === undefined) {
      blockers.push(
        `${at}: a non-call use of the symbol (passed as a value / new / JSX) — cannot rewrite`,
      );
      continue;
    }
    if (tree.findByCurrentPath(host.relOf(ref.fileName)) === null) {
      blockers.push(`${at}: a call in a file outside the tracked tree — cannot verify`);
      continue;
    }
    if (call.arguments.some((a) => ts.isSpreadElement(a))) {
      blockers.push(`${at}: a spread argument — positions are unknown`);
      continue;
    }
    if (isReorder && call.arguments.length !== paramCount) {
      // Fewer args (omitted trailing optionals) OR more (a rest parameter) → the permutation
      // isn't representable as a flat arg-list reorder; the extra/missing slots would
      // silently mis-bind or drop. Refuse rather than corrupt (the typecheck is type-blind).
      blockers.push(
        `${at}: argument count (${call.arguments.length}) ≠ parameter count (${paramCount}) — reorder cannot be represented`,
      );
      continue;
    }
    if (change.removeParam !== undefined) {
      const dropped = call.arguments[change.removeParam];
      if (dropped !== undefined && mayHaveSideEffect(dropped)) {
        const { line } = refSf.getLineAndCharacterOfPosition(dropped.getStart(refSf));
        const text = dropped.getText(refSf);
        const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
        sideEffectNotes.push(
          `${at}:${line + 1}: removed argument \`${shown}\` may have a side effect — dropped`,
        );
      }
    }
    push(ref.fileName, listEdit(refSf, call.arguments, order));
  }
  if (blockers.length > 0) {
    return `change_signature cannot safely rewrite every use — refusing: ${blockers.join('; ')}`;
  }

  // Apply per-file edits as content overrides on the tree.
  for (const [fileName, edits] of editsByFile) {
    const node = tree.findByCurrentPath(host.relOf(fileName));
    if (node === null) continue;
    const before = node.contentOverride() ?? sfByFile.get(fileName)?.text;
    if (before === undefined) continue;
    node.setContent(applyEdits(before, edits));
  }

  const plan = assemblePlan(host, tree, options);
  if (typeof plan === 'string' || sideEffectNotes.length === 0) return plan;
  return { ...plan, notes: [...(plan.notes ?? []), ...sideEffectNotes] };
}
