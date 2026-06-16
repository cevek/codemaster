// Move one top-level symbol into an EXISTING file via the LS "Move to file" refactor
// (`refactor.move.file`, with `interactiveRefactorArguments.targetFile` = the dest's abs path).
// This is `move_symbol` — the delta vs `extract_symbol` ("Move to a new file") is the dest
// ALREADY exists, so the LS itself owns the hard part: merging the moved symbol's imports into
// the dest's existing imports, handling existing-locals, rewriting every importer (including
// aliased / re-export forms), and adding the source's back-reference. We apply its edits to the
// tree and reuse `assemblePlan` (a moves-free, content-only tree → the plain plan) + the shared
// §2.8 apply/typecheck/rollback machinery; the project's OWN LS post-typecheck gates apply, so
// leaning on the LS refactor is safe even if an edit is imperfect (a bad result is refused).
//
// Deliberate deviation from spec-move-symbol's "reuse extract planning + hand-append" sketch: the
// native refactor delegates import-merge/collision/importer-rewrite to the LS (the project's own
// resolver) instead of a hand-rolled merge over `rewriteImports`, which would be a large,
// bug-prone mutation of shared move/extract code. The post-typecheck gate makes it equivalently
// safe and far simpler. (ARCHITECTURE §4 records the LS as an edit producer, not a fact oracle.)

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { messageOfThrown } from '../../../../common/result/construct.ts';
import type { RefactorPlan } from '../plan.ts';
import { assemblePlan } from '../imports/assemble.ts';
import { detectMoveSymbolCaptures } from '../capture/move-symbol.ts';
import { isExtractAssertion, isLsDebugFailure, EXTRACT_ASSERTION_NOTE } from './taxonomy.ts';
import {
  REFACTOR_FORMAT as FORMAT,
  applyTsChanges,
  targetsNestedDeclaration,
  topLevelStatementAt,
} from './statements.ts';

// Dest must be a TYPECHECKED TS file. This set is kept IN SYNC with `assemble.ts`'s `TS_RE`
// (the overlay/checkPaths filter): a `.js`/`.jsx` dest would be EDITED but never overlaid or
// typechecked, so the §2.8 gate couldn't see TS annotations written into it — a false-clean
// write (bug-review). Accepting only `.ts(x)`/`.mts`/`.cts` keeps the edit-accept set == the
// typecheck set, so every byte the move writes is gated. (move_symbol is a TS/React op.)
const TS_DEST_RE = /\.(tsx?|mts|cts)$/;
const MOVE_TO_FILE = 'Move to file';

/** The declared name of a top-level statement (the symbol the agent is moving), or undefined for
 *  an unnamed/multi-binding statement we can't pin to one name (collision/capture checks then skip
 *  — the §2.8 typecheck remains the backstop, never a false refusal). */
function topLevelDeclName(stmt: ts.Statement): string | undefined {
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)) &&
    stmt.name !== undefined &&
    ts.isIdentifier(stmt.name)
  ) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length === 1 && decls[0] !== undefined && ts.isIdentifier(decls[0].name)) {
      return decls[0].name.text;
    }
  }
  return undefined;
}

/** Names of every top-level declaration in `sf` (for the dest collision pre-check). */
function topLevelNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    const name = topLevelDeclName(stmt);
    if (name !== undefined) out.add(name);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
      }
    }
  }
  return out;
}

/** Whether a statement's subtree contains JSX (→ a `.ts` dest would not compile). */
function statementHasJsx(stmt: ts.Statement): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(stmt);
  return found;
}

export function planMoveSymbolTo(
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
  const sourceRel = host.relOf(sourceAbs);
  if (sourceRel === destArg) {
    return `move-symbol-same-file: the symbol already lives in ${destArg} — nothing to move`;
  }

  // dest must EXIST and be in the program. The LS "Move to file" errors on an existing-but-
  // unparsed file, and a NON-existent dest would route to its new-file path (extract_symbol's
  // job) — so refuse both here with a pointed message rather than silently create a file.
  if (!TS_DEST_RE.test(destArg)) {
    return `move-symbol-dest-not-ts: dest ${destArg} is not a TypeScript module file (.ts/.tsx/.mts/.cts) — move_symbol typechecks the dest, and a .js/.jsx dest would not be checked`;
  }
  const destAbs = host.absOf(destArg);
  const destNode = tree.findByCurrentPath(destArg);
  const destSf = program?.getSourceFile(destAbs);
  if (destNode === null || destSf === undefined) {
    return `move-symbol-dest-not-in-project: dest ${destArg} is not an existing tracked file in the TS project (check the path spelling; to create a NEW file, use extract_symbol)`;
  }

  const stmt = topLevelStatementAt(sf, offset);
  if (stmt === undefined) return 'no top-level declaration at the target position';
  // Refuse a nested target rather than silently move its top-level ancestor (§4a) — the LS
  // refactor below acts on `stmt` (the enclosing top-level statement).
  if (targetsNestedDeclaration(sf, offset, stmt)) {
    return 'ts-ls-nested-target: the target is a declaration nested inside another (the LS "Move to file" relocates only a TOP-LEVEL symbol) — move its enclosing top-level symbol, or lift this one to the top level first';
  }

  const movedName = topLevelDeclName(stmt);
  // Name collision in dest → REFUSE (never clobber/shadow). The §2.8 typecheck is the backstop,
  // but a pointed pre-check is the honest message the spec asks for.
  if (movedName !== undefined && topLevelNames(destSf).has(movedName)) {
    return `move-symbol-name-collision: dest ${destArg} already declares a top-level \`${movedName}\` — moving it here would duplicate/shadow that symbol (refused; rename one first or choose another dest)`;
  }
  // A JSX body compiles only in a `.tsx` dest — refuse any non-`.tsx` dest upfront (covers
  // .ts/.mts/.cts, clearer than the gate's "JSX only in .tsx" diagnostic).
  if (statementHasJsx(stmt) && !destArg.endsWith('.tsx')) {
    return `move-symbol-jsx-dest: the symbol's body contains JSX but dest ${destArg} is not a .tsx file — move it into a .tsx file`;
  }

  const range: ts.TextRange = { pos: stmt.getStart(sf), end: stmt.getEnd() };
  const requestEdits = (service: ts.LanguageService): ts.RefactorEditInfo | undefined =>
    service.getEditsForRefactor(
      sourceAbs,
      FORMAT,
      range,
      MOVE_TO_FILE,
      MOVE_TO_FILE,
      { allowTextChangesInNewFiles: true },
      { targetFile: destAbs },
    ) ?? undefined;

  let edits: ts.RefactorEditInfo | undefined;
  let rescued = false;
  try {
    edits = requestEdits(host.service);
  } catch (thrown) {
    const msg = messageOfThrown(thrown);
    if (!isExtractAssertion(msg)) {
      if (isLsDebugFailure(msg))
        return `ts-ls-internal: the LS hit an internal assertion — move manually (${msg})`;
      return `move failed: ${msg}`;
    }
    // §4 rescue: the stock LS asserted on a shape it can't move (e.g. the moved block uses a
    // css-module member). Retry through the patched fork; the project's own §2.8 typecheck still
    // gates the result. Unavailable/also-fails → honest ts-ls-internal, never a guessed edit.
    const fallback = host.rescueService();
    if (fallback === undefined) return `ts-ls-internal: ${EXTRACT_ASSERTION_NOTE} (${msg})`;
    try {
      edits = requestEdits(fallback);
      rescued = true;
    } catch (rethrown) {
      return `ts-ls-internal: ${EXTRACT_ASSERTION_NOTE} (rescue also failed: ${messageOfThrown(rethrown)})`;
    }
  }
  // notApplicableReason rides on the RefactorEditInfo for a refusal the LS can explain.
  if (edits?.notApplicableReason !== undefined) {
    return `move-symbol-not-applicable: ${edits.notApplicableReason}`;
  }
  if (edits === undefined || edits.edits.length === 0) {
    return 'ts-ls-no-edits: the LS produced no edits for this move — move manually';
  }
  // The dest exists, so the LS must edit it in place — a `isNewFile` here means it routed to the
  // new-file path (a contract surprise we won't silently honour: it would lose dest's content).
  for (const fc of edits.edits) {
    if (fc.isNewFile) {
      return `move-symbol: the LS unexpectedly created ${host.relOf(fc.fileName)} — dest must be an existing file (refused)`;
    }
  }

  // Apply the LS edits to the tree (content overrides only — no file moves). Each file's base is
  // its current override (if an earlier fc already touched it) else the program text.
  for (const fc of edits.edits) {
    const rel = host.relOf(fc.fileName);
    const node = tree.findByCurrentPath(rel) ?? tree.findByInitialPath(rel);
    if (node === null) return `move-symbol: edits target an unknown file ${rel}`;
    const base =
      node.contentOverride() ?? program?.getSourceFile(host.absOf(node.initialPath()))?.text;
    // No resolvable content → splicing real offsets into '' would silently corrupt the file.
    // Fail honestly (§3.6) — never a half-write.
    if (base === undefined) {
      return `move-symbol: edits target a file with no resolvable content (${rel}) — move manually`;
    }
    node.setContent(applyTsChanges(base, fc.textChanges));
  }

  const plan = assemblePlan(host, tree, options);
  if (typeof plan === 'string') return plan;
  if (rescued) plan.rescued = true;
  // The importer rewrites here are LS-driven (not `rewriteImports`), so `assemblePlan` recorded no
  // capture metadata. Reconstruct it from the post-edit importers of the moved symbol and run the
  // shared path-capture gate (§7 capture-safety) so a same-named, type-compatible export at the
  // dest path is caught, not waved through.
  plan.captures = detectMoveSymbolCaptures(host, options, plan, destArg, movedName);
  return plan;
}
