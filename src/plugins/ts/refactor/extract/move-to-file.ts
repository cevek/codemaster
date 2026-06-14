// Extract a top-level symbol to a new file via the LS "Move to a new file" refactor, then
// re-target the LS-chosen filename to the requested `dest`. The LS emits the new file + edits
// to the source (symbol removed, import added) + consumer edits; we apply them to the tree
// and let `assemblePlan`'s import pass rewrite the LS-named import to `dest`. The refactor
// call is WRAPPED — the `Expected symbol to be a module` Debug Failure is thrown by the LS,
// so without this it would crash instead of failing honestly (§3.6).
//
// §4 patched-LS rescue: the `Expected symbol to be a module` assertion (thrown e.g. when the
// extracted block uses a css-module member) is retried through the host's fallback LS from the
// patched fork; the result still passes the project's own §2.8 typecheck. When the rescue is
// unavailable the assertion path fails honestly with the `ts-ls-internal` category. The css
// co-extract analysis (`plan.cssExtract`) is built here when requested; the op does the join.

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { messageOfThrown } from '../../../../common/result/construct.ts';
import { applyEdits } from '../../../../support/text-edits/apply.ts';
import type { RefactorPlan, CssExtractAnalysis } from '../plan.ts';
import { assemblePlan } from '../imports/assemble.ts';
import { analyzeCssExtractUsage } from './css-usage.ts';
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
  css = false,
): RefactorPlan | string {
  const program = host.service.getProgram();
  const sf = program?.getSourceFile(sourceAbs);
  if (sf === undefined) return 'source file not in the TS project';
  const stmt = topLevelStatementAt(sf, offset);
  if (stmt === undefined) return 'no top-level declaration at the target position';
  const range: ts.TextRange = { pos: stmt.getStart(sf), end: stmt.getEnd() };

  const requestEdits = (service: ts.LanguageService): ts.RefactorEditInfo | undefined =>
    service.getEditsForRefactor(
      sourceAbs,
      FORMAT,
      range,
      'Move to a new file',
      'Move to a new file',
      {},
    ) ?? undefined;

  let edits: ts.RefactorEditInfo | undefined;
  let rescued = false;
  try {
    edits = requestEdits(host.service);
  } catch (thrown) {
    const msg = messageOfThrown(thrown);
    if (!isExtractAssertion(msg)) {
      if (isLsDebugFailure(msg))
        return `ts-ls-internal: the LS hit an internal assertion — extract manually (${msg})`;
      return `extract failed: ${msg}`;
    }
    // §4 rescue: the stock LS asserted on a shape it can't move (e.g. the extracted block
    // uses a css-module member). Retry through the patched fork; if unavailable or it also
    // fails, surface the honest ts-ls-internal failure — never a guessed edit.
    const fallback = host.rescueService();
    if (fallback === undefined) return `ts-ls-internal: ${EXTRACT_ASSERTION_NOTE} (${msg})`;
    try {
      edits = requestEdits(fallback);
      rescued = true;
    } catch (rethrown) {
      return `ts-ls-internal: ${EXTRACT_ASSERTION_NOTE} (rescue also failed: ${messageOfThrown(rethrown)})`;
    }
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

  const plan = assemblePlan(host, tree, options);
  if (typeof plan === 'string') return plan;
  if (rescued) plan.rescued = true;
  if (css) {
    const analysis = buildCssExtractAnalysis(host, tree, dest, sourceAbs);
    if (analysis !== undefined) plan.cssExtract = analysis;
  }
  return plan;
}

/** Read the planned extracted + remaining contents from the tree and run the §2.3 block-scoped
 *  css analysis, resolving each import's sheet relative to the extracted file via the tree
 *  (`findByCurrentPath ?? findByInitialPath` — robust to the new file's two coordinate
 *  systems). Returns undefined when the extracted file has no css-module import. */
function buildCssExtractAnalysis(
  host: TsProjectHost,
  tree: VFSTree,
  dest: RepoRelPath,
  sourceAbs: string,
): CssExtractAnalysis | undefined {
  const extractedNode = tree.findByCurrentPath(dest);
  const extractedContent = extractedNode?.contentOverride();
  if (extractedNode === null || extractedContent === null || extractedContent === undefined) {
    return undefined;
  }
  const sourceRel = host.relOf(sourceAbs);
  const sourceNode = tree.findByCurrentPath(sourceRel) ?? tree.findByInitialPath(sourceRel);
  const remainingContent =
    sourceNode?.contentOverride() ??
    host.service.getProgram()?.getSourceFile(sourceAbs)?.text ??
    '';

  const usages = analyzeCssExtractUsage(
    { fileName: dest, content: extractedContent },
    { fileName: sourceRel, content: remainingContent },
  );
  if (usages.length === 0) return undefined;

  const destDir = posixDirname(dest);
  const candidates = usages.map((u) => {
    const sheetRel = resolveSheetRel(tree, destDir, u.specifier);
    return {
      localName: u.localName,
      specifier: u.specifier,
      ...(sheetRel !== undefined ? { sheetRel } : {}),
      refsInExtracted: u.refsInExtracted,
      refsInRemaining: u.refsInRemaining,
      remainingWildcard: u.remainingWildcard,
      extractedWildcard: u.extractedWildcard,
    };
  });
  return { extractedFile: dest, sourceFile: sourceRel, candidates };
}

/** Resolve a css import specifier (relative to the extracted file's dir) to a tracked sheet
 *  path. Aliased (non-relative) or untracked specifiers → undefined (the op moves nothing). */
function resolveSheetRel(
  tree: VFSTree,
  destDir: string,
  specifier: string,
): RepoRelPath | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = destDir === '' ? specifier : `${destDir}/${specifier}`;
  const rel = normalizePosix(joined);
  if (rel === undefined) return undefined; // climbed above the repo root → can't resolve safely
  const node =
    tree.findByCurrentPath(rel as RepoRelPath) ?? tree.findByInitialPath(rel as RepoRelPath);
  return node !== null ? (rel as RepoRelPath) : undefined;
}

/** Normalize a posix path (resolve `.`/`..` segments) without touching the filesystem. Returns
 *  undefined if a `..` climbs above the root — resolving such a path would silently point at the
 *  wrong file (e.g. a same-named sheet at root), so the caller must decline. */
function normalizePosix(p: string): string | undefined {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return undefined; // underflow above root
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}
