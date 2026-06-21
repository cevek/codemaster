// Extract a top-level symbol to a NEW file via the LS "Move to file" refactor
// (`refactor.move.file`) with `interactiveRefactorArguments.targetFile` = the requested `dest`'s
// abs path — a path that does NOT yet exist, so the LS creates it (`isNewFile`). This is the SAME
// action `move_symbol` drives (move-to-existing.ts); the delta is only that the dest is new. We use
// it instead of the legacy "Move to a new file" action because that one (a) let the LS pick the
// filename — forcing a re-target + an `emitSpecifier` re-emit that mangled aliased importers to
// relative — and (b) never mirrored each importer's import convention. "Move to file" emits every
// importer/relink/dep specifier NATIVELY, mirroring the file's own convention (alias→alias,
// relative→relative) + extension, so codemaster reforms nothing (the dogfood fix: aliased repos keep
// `@/…`). The refactor call is WRAPPED — the `Expected symbol to be a module` / `Changes overlap`
// Debug Failures are thrown by the LS, so without this it would crash instead of failing honestly.
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
import type { RefactorPlan, CssExtractAnalysis, PlanningOverlay } from '../plan.ts';
import { assemblePlan } from '../imports/assemble.ts';
import { detectMoveSymbolCaptures } from '../capture/move-symbol.ts';
import { rebaseAmbientImports } from '../imports/rebase-ambient.ts';
import { fileExists } from '../../../../support/fs/exists.ts';
import { analyzeCssExtractUsage } from './css-usage.ts';
import { requestEditsWithRescue } from './taxonomy.ts';
import {
  REFACTOR_FORMAT as FORMAT,
  MOVE_TO_FILE,
  applyTsChanges,
  posixBasename,
  posixDirname,
  sourceLeadingGap,
  statementHasJsx,
  targetsNestedDeclaration,
  topLevelDeclName,
  topLevelStatementAt,
} from './statements.ts';
import { normalizeExtractedContent } from '../normalize/relocated-file.ts';

export function planExtractTo(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  sourceAbs: string,
  offset: number,
  destArg: RepoRelPath,
  css = false,
  // The cumulative prior-step overlay when this is a `transaction` step ≥2 — forwarded to the
  // import-capture gate so it re-resolves against prior moves/edits, not pre-transaction disk (E-g).
  overlay?: PlanningOverlay,
): RefactorPlan | string {
  const program = host.service.getProgram();
  const sf = program?.getSourceFile(sourceAbs);
  if (sf === undefined) return 'source file not in the TS project';
  const stmt = topLevelStatementAt(sf, offset);
  if (stmt === undefined) return 'no top-level declaration at the target position';
  // Refuse a nested target rather than silently extract its top-level ancestor (§4a). The LS
  // refactor below operates on `stmt` (the enclosing top-level statement), so a nested symbol would
  // be acted on as a different symbol than requested — the exact silent retarget §6 forbids.
  if (targetsNestedDeclaration(sf, offset, stmt)) {
    return 'ts-ls-nested-target: the target is a declaration nested inside another (the LS "Move to file" extracts only a TOP-LEVEL symbol) — extract its enclosing top-level symbol, or lift this one to the top level first';
  }

  // The LS creates the file at exactly the `targetFile` we pass, so coerce a JSX body's dest
  // `.ts`→`.tsx` BEFORE the call (a JSX body in a `.ts` file would not compile). move_symbol REFUSES
  // a non-`.tsx` JSX dest (its dest pre-exists); extract can CREATE the corrected one.
  let dest = destArg;
  if (statementHasJsx(stmt) && dest.endsWith('.ts') && !dest.endsWith('.tsx')) {
    dest = `${dest}x` as RepoRelPath;
  }
  // extract CREATES the dest — an existing dest is `move_symbol`'s job, not ours. A TRACKED dest
  // is in the tree; a GITIGNORED/untracked one is invisible to the tree but real on disk, and
  // passing it as `targetFile` would make the LS MERGE into it (lose its content) — so check BOTH,
  // refusing before any write. (The dirtyOk waiver can never license overwriting an unrecoverable
  // on-disk file; this is the §3.6 honest refusal the agent acts on.)
  if (tree.findByCurrentPath(dest) !== null || fileExists(host.absOf('' as RepoRelPath), dest)) {
    return `destination already exists: ${dest} — refusing to overwrite; use move_symbol to move into an existing file`;
  }
  const destAbs = host.absOf(dest);

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

  // Request the LS edits, routing the two known rescuable assertions (`Expected symbol to be a
  // module`, `Changes overlap`) through the §4 patched-LS rescue; a recognized assertion the
  // rescue can't resolve fails with a SANITIZED message (never the raw internal string), an
  // unrecognized failure surfaces honestly. Runs before any tree write → never a half-write.
  const outcome = requestEditsWithRescue(host, requestEdits, 'extract');
  if ('error' in outcome) return outcome.error;
  const { edits, rescued } = outcome;
  if (edits?.notApplicableReason !== undefined) {
    return `extract-not-applicable: ${edits.notApplicableReason}`;
  }
  if (edits === undefined || edits.edits.length === 0) {
    return 'ts-ls-no-edits: the LS produced no edits for this extract — extract manually';
  }

  // Apply the LS edits to the tree: the new file (created at `dest`) + source/consumer edits.
  let createdNewFile = false;
  for (const fc of edits.edits) {
    const rel = host.relOf(fc.fileName);
    if (fc.isNewFile) {
      // The LS must create exactly our dest (it does — we passed it as targetFile). Anything else
      // is a contract surprise we refuse rather than silently honour.
      if (rel !== dest) {
        return `extract: the LS created an unexpected file ${rel} (expected ${dest})`;
      }
      const content = applyTsChanges('', fc.textChanges);
      const parent = tree.ensureDirAtCurrent(posixDirname(rel) as RepoRelPath);
      if (parent.childByCurrent(posixBasename(rel)) !== undefined) {
        return `extract: dest ${rel} already exists`;
      }
      tree.addFileAtCurrent(parent, posixBasename(rel), content);
      createdNewFile = true;
    } else {
      const node = tree.findByCurrentPath(rel) ?? tree.findByInitialPath(rel);
      if (node === null) {
        // The LS rewrites an importer the move-tree has no node for — chiefly a GITIGNORED importer
        // the TS program compiles but git's listing EXCLUDES. We can't track/roll back an edit to it,
        // so REFUSE honestly (nothing written — the tree is in-memory) rather than half-extract.
        const inProgram = program?.getSourceFile(host.absOf(rel)) !== undefined;
        return inProgram
          ? `extract-importer-untracked: the extract rewrites ${rel}, which the TS program compiles but git's file listing EXCLUDES (gitignored, or otherwise untracked) — codemaster can't safely track or roll back an edit to it. git-track ${rel} (or drop its ignore) and retry, or extract manually.`
          : `extract: edits target ${rel}, which is in neither the move tree nor the TS program — refusing (nothing written); extract manually.`;
      }
      const base =
        node.contentOverride() ?? program?.getSourceFile(host.absOf(node.initialPath()))?.text;
      // No resolvable content (no override, not in the program) → splicing the LS's real
      // offsets into '' would silently produce garbage. Fail honestly (§3.6).
      if (base === undefined) {
        return `extract: edits target a file with no resolvable content (${rel}) — extract manually`;
      }
      node.setContent(applyTsChanges(base, fc.textChanges));
    }
  }
  if (!createdNewFile) return 'extract: the refactor produced no new file';

  // Rebase the new file's verbatim-copied AMBIENT imports (`*.module.scss`, …) for the source→dest
  // directory shift — the LS re-emits TS imports relative to `dest` but copies an unresolvable
  // ambient specifier as-written (valid only from the source's dir). Scoped to the new file's
  // ambient imports; TS/alias imports the LS already placed are untouched.
  rebaseAmbientImports(host, tree, options, dest, sourceAbs);

  // Normalize the relocated new file (reattach the moved symbol's doc, fold same-module duplicate
  // imports) before the plan reads it. Scoped to the new file only — the source's edits are untouched.
  const relocated = tree.findByCurrentPath(dest);
  const relocatedContent = relocated?.contentOverride();
  if (relocated !== null && relocatedContent !== null && relocatedContent !== undefined) {
    relocated.setContent(
      normalizeExtractedContent(
        relocatedContent,
        topLevelDeclName(stmt),
        sourceLeadingGap(sf, stmt),
      ),
    );
  }

  const plan = assemblePlan(host, tree, options, overlay);
  if (typeof plan === 'string') return plan;
  if (rescued) plan.rescued = true;
  // Importer rewrites are LS-driven (no tree move → `rewriteImports` is a no-op), so `assemblePlan`
  // recorded no capture metadata. Reconstruct it from the post-edit importers of the moved symbol
  // and run the shared path-capture gate (§7) — parity with move_symbol — so a same-named,
  // type-compatible export at the dest path is caught, not waved through.
  plan.captures = detectMoveSymbolCaptures(
    host,
    options,
    plan,
    dest,
    topLevelDeclName(stmt),
    overlay !== undefined ? { files: overlay.files, removed: overlay.removed } : undefined,
  );
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
