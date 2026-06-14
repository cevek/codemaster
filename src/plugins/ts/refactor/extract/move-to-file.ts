// Extract a top-level symbol to a new file via the LS "Move to a new file" refactor, then
// re-target the LS-chosen filename to the requested `dest`. The LS emits the new file + edits
// to the source (symbol removed, import added) + consumer edits; we apply them to the tree
// and let `assemblePlan`'s import pass rewrite the LS-named import to `dest`. The refactor
// call is WRAPPED — the `Expected symbol to be a module` Debug Failure is thrown by the LS,
// so without this it would crash instead of failing honestly (§3.6).
//
// §4 (patched-LS rescue) and CSS co-extract are NOT wired here yet — deliberately deferred;
// the assertion path fails honestly with the `ts-ls-internal` category.

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { messageOfThrown } from '../../../../common/result/construct.ts';
import { applyEdits } from '../../../../support/text-edits/apply.ts';
import type { RefactorPlan } from '../plan.ts';
import { assemblePlan } from '../imports/assemble.ts';
import { isExtractAssertion, isLsDebugFailure, EXTRACT_ASSERTION_NOTE } from './taxonomy.ts';

const FORMAT: ts.FormatCodeSettings = { convertTabsToSpaces: true, tabSize: 2, indentSize: 2 };
const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const posixBasename = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
};

function applyTsChanges(content: string, changes: readonly ts.TextChange[]): string {
  return applyEdits(
    content,
    changes.map((c) => ({
      start: c.span.start,
      end: c.span.start + c.span.length,
      text: c.newText,
    })),
  );
}

/** The top-level statement enclosing `offset`, or undefined if the position isn't on one. */
function topLevelStatementAt(sf: ts.SourceFile, offset: number): ts.Statement | undefined {
  for (const stmt of sf.statements) {
    if (offset >= stmt.getStart(sf) && offset < stmt.getEnd()) return stmt;
  }
  return undefined;
}

export function planExtractTo(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  sourceAbs: string,
  offset: number,
  destArg: RepoRelPath,
): RefactorPlan | string {
  const program = host.service.getProgram();
  const sf = program?.getSourceFile(sourceAbs);
  if (sf === undefined) return 'source file not in the TS project';
  const stmt = topLevelStatementAt(sf, offset);
  if (stmt === undefined) return 'no top-level declaration at the target position';
  const range: ts.TextRange = { pos: stmt.getStart(sf), end: stmt.getEnd() };

  let edits: ts.RefactorEditInfo | undefined;
  try {
    edits =
      host.service.getEditsForRefactor(
        sourceAbs,
        FORMAT,
        range,
        'Move to a new file',
        'Move to a new file',
        {},
      ) ?? undefined;
  } catch (thrown) {
    const msg = messageOfThrown(thrown);
    if (isExtractAssertion(msg)) return `ts-ls-internal: ${EXTRACT_ASSERTION_NOTE} (${msg})`;
    if (isLsDebugFailure(msg))
      return `ts-ls-internal: the LS hit an internal assertion — extract manually (${msg})`;
    return `extract failed: ${msg}`;
  }
  if (edits === undefined || edits.edits.length === 0) {
    return 'ts-ls-no-edits: the LS produced no edits for this extract — extract manually';
  }

  // Apply the LS edits to the tree: one new file (LS picks the name) + source/consumer edits.
  let createdInitial: RepoRelPath | undefined;
  for (const fc of edits.edits) {
    const rel = host.relOf(fc.fileName);
    if (fc.isNewFile) {
      const content = applyTsChanges('', fc.textChanges);
      const parent = tree.ensureDirAtCurrent(posixDirname(rel) as RepoRelPath);
      if (parent.childByCurrent(posixBasename(rel)) !== undefined) {
        return `extract: the LS chose an existing filename ${rel} — pick a different dest`;
      }
      tree.addFileAtCurrent(parent, posixBasename(rel), content);
      createdInitial = rel;
    } else {
      const node = tree.findByInitialPath(rel) ?? tree.findByCurrentPath(rel);
      if (node === null) return `extract: edits target an unknown file ${rel}`;
      const base =
        node.contentOverride() ?? program?.getSourceFile(host.absOf(node.initialPath()))?.text;
      // No resolvable content (no override, not in the program) → splicing the LS's real
      // offsets into '' would silently produce garbage. Fail honestly (§3.6). The LS only
      // edits files it has, so this is a defensive guard, not an expected path.
      if (base === undefined) {
        return `extract: edits target a file with no resolvable content (${rel}) — extract manually`;
      }
      node.setContent(applyTsChanges(base, fc.textChanges));
    }
  }
  if (createdInitial === undefined) return 'extract: the refactor produced no new file';

  // Coerce dest to .tsx when the LS produced a .tsx (the body has JSX) — §G JSX coercion.
  let dest = destArg;
  if (createdInitial.endsWith('.tsx') && dest.endsWith('.ts') && !dest.endsWith('.tsx')) {
    dest = `${dest}x` as RepoRelPath;
  }
  if (tree.findByCurrentPath(dest) !== null && dest !== createdInitial) {
    return `destination already exists: ${dest}`;
  }

  // Re-target the LS-chosen new file to the requested dest; assemblePlan then rewrites the
  // source's import (still pointing at the LS name) to dest.
  if (createdInitial !== dest) {
    const createdNode = tree.findByCurrentPath(createdInitial);
    if (createdNode === null) return `extract: created node not found at ${createdInitial}`;
    const targetParent = tree.ensureDirAtCurrent(posixDirname(dest) as RepoRelPath);
    try {
      createdNode.moveTo(targetParent, posixBasename(dest));
    } catch (thrown) {
      return `extract: cannot place new file at ${dest}: ${messageOfThrown(thrown)}`;
    }
    tree.rekeyByInitialPath(createdNode, dest);
  }

  return assemblePlan(host, tree, options);
}
