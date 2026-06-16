// Symbol-anchored rename via the LanguageService (spec Stage D, ports rename.ts). The LS
// resolves the symbol and returns every semantic reference site — aliased imports, JSX,
// re-exports — that a textual replace would miss or over-match. We turn those sites into a
// per-file before/after pair (the edit substrate reuses Stage A's `applyEdits`, so the
// rename inherits its overlap/ordering guarantees). A *redeclaration* collision is left to the
// post-edit typecheck (§2.8) — it surfaces as a duplicate-identifier diagnostic. But a CAPTURE
// (the new name shadows / is shadowed by an in-scope binding so a reference silently re-binds to a
// DIFFERENT symbol) is type-compatible and NOT a redeclaration, so the typecheck can't see it — we
// detect it here against the post-edit program's reference set (`detectRenameCapture`) and refuse.

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import type { Span } from '../../../../core/span.ts';
import { spanFromRange } from '../../spans.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';
import type { Capture } from '../capture/types.ts';
import { detectRenameCapture } from '../capture/rename.ts';
import { findRenameLocationsAcross, findRenameLocationsPrimary } from '../../cross-program.ts';

interface RenameChange {
  path: RepoRelPath;
  before: string;
  after: string;
}

export interface RenameOutcome {
  changes: RenameChange[];
  /** Files holding rename locations we could NOT edit (not in the current program). The
   *  §2.8 typecheck only checks edited files, so it can't catch an incomplete rename — a
   *  drop here is surfaced as a partial, never swallowed (else the op would claim a clean,
   *  complete rename over a knowingly trimmed edit set). Normally empty. */
  dropped: RepoRelPath[];
  /** The symbol's identifier text BEFORE the rename — the name the op scans for as a
   *  surviving re-export alias / `export *` consumer (the completeness signal). Faithfully
   *  read off the renamed position; not part of the rewrite. */
  oldName: string;
  /** Capture sites (§ capture-safety): rewritten references that would silently re-bind to a
   *  DIFFERENT symbol, or a pre-existing `newName` token now binding to the renamed one. Empty
   *  when the rename is semantically clean. Surfaced on the envelope (refuses apply when
   *  non-empty) rather than failing the whole op — so the agent still sees the diff. */
  captures: Capture[];
}

/** Compute the per-file rename edits for the symbol at `abs:offset`, or a message string
 *  when the position cannot be renamed (no rename locations — e.g. a non-identifier). */
export function computeRename(
  host: TsProjectHost,
  abs: string,
  offset: number,
  newName: string,
  /** Fan the rename-site computation across EVERY loaded program (default) so a `test/**` site
   *  under a sibling tsconfig is rewritten too — not just the primary program's sites. Set
   *  `false` on the transaction path (the primary carries a planning overlay, so a sibling
   *  reading stale disk would be unsound — ls-host TRAP); that stays a documented cross-program
   *  transaction gap, and the §2.8 gate (which DOES fan out) still refuses a resulting dangle. */
  crossProgram = true,
): RenameOutcome | string {
  // `providePrefixAndSuffixTextForRename: true` is load-bearing (set inside the fan-out): without
  // it the LS returns a shorthand-property site (`{ foo }`) with no prefix/suffix, so renaming
  // `foo`→`bar` would rewrite it to `{ bar }` — silently renaming the KEY and changing the
  // object's shape (the typecheck can't catch a same-shaped object). With it, the site carries
  // `bar: ` so it expands to `{ bar: foo }`.
  const resolved = crossProgram
    ? findRenameLocationsAcross(host, abs, offset)
    : findRenameLocationsPrimary(host, abs, offset);
  if (resolved === undefined || resolved.locations.length === 0) {
    return 'cannot rename at this position (the LS found no rename locations)';
  }
  const { locations, sourceFiles } = resolved;

  const byFile = new Map<string, TextEdit[]>();
  for (const loc of locations) {
    const edits = byFile.get(loc.fileName) ?? [];
    // A rename location may carry prefix/suffix text (shorthand property expansion); honour
    // it so `{ foo }` → `{ bar: foo }` style rewrites stay valid.
    const text = `${loc.prefixText ?? ''}${newName}${loc.suffixText ?? ''}`;
    edits.push({ start: loc.textSpan.start, end: loc.textSpan.start + loc.textSpan.length, text });
    byFile.set(loc.fileName, edits);
  }

  const changes: RenameChange[] = [];
  const dropped: RepoRelPath[] = [];
  for (const [fileName, edits] of byFile) {
    const sourceFile = sourceFiles.get(fileName);
    if (sourceFile === undefined) {
      dropped.push(host.relOf(fileName)); // a rename location no program can load — surfaced, not swallowed
      continue;
    }
    const before = sourceFile.text;
    changes.push({ path: host.relOf(fileName), before, after: applyEdits(before, edits) });
  }
  if (changes.length === 0) return 'rename produced no in-project edits';

  // CAPTURE GUARD (the typecheck is NOT a sufficient oracle here): if `newName` is already an
  // in-scope binding at a rewritten site, the rewritten reference binds to THAT binding, not to the
  // renamed symbol — silent semantic corruption (`slugify(x)`→`upper(x)` calls a local `upper`).
  // It is type-compatible, so the §2.8 gate stays clean; and it is NOT a duplicate-identifier, so
  // the LS doesn't flag it. Verify against the post-edit program (refs, not types). Surfaced on the
  // outcome — the op shows the diff + refuses apply — not failed here (so the agent sees the edit).
  // PRIMARY-only (the LS reference oracle sees the primary program): pass only primary-resident
  // sites/changes so a `test/**` site is neither a false forward-capture nor overlaid onto the
  // primary. A cross-program type-compatible re-bind is therefore NOT caught here — a documented
  // gap (the §2.8 fan-out gate catches a resulting dangle, just not a same-typed silent re-bind).
  const primaryProgram = host.service.getProgram();
  const primaryLocations = locations.filter(
    (l) => primaryProgram?.getSourceFile(l.fileName) !== undefined,
  );
  const primaryChanges = changes.filter(
    (c) => primaryProgram?.getSourceFile(host.absOf(c.path)) !== undefined,
  );
  const captures = detectRenameCapture(
    host,
    abs,
    offset,
    newName,
    primaryLocations,
    primaryChanges,
  );

  return { changes, dropped, oldName: identifierAround(host, abs, offset), captures };
}

/** The `export { <new> as <old> }` re-export aliases in `content` — the public name the LS
 *  preserved when it renamed `<old>`→`<new>`. Found via the TS AST (NOT a text scan): only a real
 *  ExportSpecifier matches, so a value/type assertion `x as Old`, a comment, a string literal, or
 *  a `$`/unicode identifier can neither false-positive nor be silently missed. `content` is the
 *  FORMATTED post-rename text, so each span matches the bytes apply writes (§3.2). */
export function findReExportAliasSites(
  rel: RepoRelPath,
  content: string,
  newName: string,
  oldName: string,
): Span[] {
  const sf = ts.createSourceFile(
    String(rel),
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: Span[] = [];
  const visit = (node: ts.Node): void => {
    // `export { new as old }`: propertyName is the local (renamed) name, name is the exported
    // (preserved old) name. A plain `export { x }` has propertyName === undefined — skipped.
    if (
      ts.isExportSpecifier(node) &&
      node.propertyName?.text === newName &&
      node.name.text === oldName
    ) {
      out.push(spanFromRange(sf, rel, node.getStart(sf), node.getEnd()));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The identifier text covering `offset` (the renamed position) — expanded both ways to the
 *  word boundaries so a target landing mid-token still yields the whole name. Empty when the
 *  position isn't in the program (the op then simply skips the old-name-survives scan). */
function identifierAround(host: TsProjectHost, abs: string, offset: number): string {
  const text = host.service.getProgram()?.getSourceFile(abs)?.text;
  if (text === undefined) return '';
  const word = /[\w$]/;
  let start = offset;
  let end = offset;
  while (start > 0 && word.test(text[start - 1] ?? '')) start--;
  while (end < text.length && word.test(text[end] ?? '')) end++;
  return text.slice(start, end);
}
