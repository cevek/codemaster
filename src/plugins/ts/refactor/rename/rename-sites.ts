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
}

/** Compute the per-file rename edits for the symbol at `abs:offset`, or a message string
 *  when the position cannot be renamed (no rename locations — e.g. a non-identifier). */
export function computeRename(
  host: TsProjectHost,
  abs: string,
  offset: number,
  newName: string,
): RenameOutcome | string {
  // `providePrefixAndSuffixTextForRename: true` is load-bearing: without it the LS returns a
  // shorthand-property site (`{ foo }`) with no prefix/suffix, so renaming `foo`→`bar` would
  // rewrite it to `{ bar }` — silently renaming the KEY and changing the object's shape (the
  // typecheck can't catch a same-shaped object). With it, the site carries `bar: ` so it
  // expands to `{ bar: foo }`.
  const locations = host.service.findRenameLocations(abs, offset, false, false, {
    providePrefixAndSuffixTextForRename: true,
  });
  if (locations === undefined || locations.length === 0) {
    return 'cannot rename at this position (the LS found no rename locations)';
  }

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
    const sourceFile = host.service.getProgram()?.getSourceFile(fileName);
    if (sourceFile === undefined) {
      dropped.push(host.relOf(fileName)); // a rename location we cannot edit — surfaced, not swallowed
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
  // the LS doesn't flag it. Verify against the post-edit program instead (refs, not types).
  const captured = detectRenameCapture(host, abs, offset, newName, locations, changes);
  if (captured.length > 0) {
    return (
      `rename to '${newName}' would CAPTURE an in-scope binding — refused (a type-compatible ` +
      `shadow is NOT proof the rename is correct): ${captured.join('; ')}. ` +
      `Pick a different newName, or remove the shadowing binding first.`
    );
  }

  return { changes, dropped, oldName: identifierAround(host, abs, offset) };
}

/** Human site descriptors (`file:line:col …`) where renaming to `newName` would silently re-bind a
 *  reference to a DIFFERENT symbol — or pull a pre-existing `newName` reference onto the renamed
 *  one. Empty when the rename is semantically clean. We let the LS resolve references over the
 *  POST-EDIT overlay (it handles aliases / overloads / shorthand), then compare that reference set
 *  to the exact sites we rewrote: any divergence (either direction) is a capture. When the anchor
 *  can't be established we return empty — we never fabricate a refusal (§3), only the typecheck
 *  guards that residual edge. */
function detectRenameCapture(
  host: TsProjectHost,
  abs: string,
  offset: number,
  newName: string,
  locations: readonly ts.RenameLocation[],
  changes: readonly RenameChange[],
): string[] {
  // Anchor on the symbol's DECLARATION — it cannot be captured (it IS the renamed symbol).
  const declDef = host.service.getDefinitionAtPosition(abs, offset)?.[0];
  if (declDef === undefined) return [];

  // The NEW position of each rewritten `newName` token (positions shift as earlier edits in the
  // same file change length). The token sits after any prefix the LS added (shorthand expansion).
  const newTokenStart = new Map<ts.RenameLocation, number>();
  const byFile = new Map<string, ts.RenameLocation[]>();
  for (const l of locations) {
    const arr = byFile.get(l.fileName) ?? [];
    arr.push(l);
    byFile.set(l.fileName, arr);
  }
  let declNewStart: number | undefined;
  for (const [fileName, locs] of byFile) {
    locs.sort((a, b) => a.textSpan.start - b.textSpan.start);
    let delta = 0;
    for (const l of locs) {
      const tokStart = l.textSpan.start + delta + (l.prefixText?.length ?? 0);
      newTokenStart.set(l, tokStart);
      if (fileName === declDef.fileName && l.textSpan.start === declDef.textSpan.start) {
        declNewStart = tokStart;
      }
      const repl = `${l.prefixText ?? ''}${newName}${l.suffixText ?? ''}`;
      delta += repl.length - l.textSpan.length;
    }
  }
  if (declNewStart === undefined) return []; // decl not among rename locations → can't verify

  host.setOverlay(changes.map((c) => ({ abs: host.absOf(c.path), content: c.after })));
  try {
    const post = host.service.getReferencesAtPosition(declDef.fileName, declNewStart);
    if (post === undefined) return [];
    const program = host.service.getProgram();
    const key = (f: string, s: number): string => `${f}|${s}`;
    const postSet = new Set(post.map((r) => key(r.fileName, r.textSpan.start)));
    const mineSet = new Set<string>();
    for (const [l, s] of newTokenStart) mineSet.add(key(l.fileName, s));

    const describe = (fileName: string, start: number, why: string): string => {
      const sf = program?.getSourceFile(fileName);
      const lc = sf ? sf.getLineAndCharacterOfPosition(start) : undefined;
      const where = lc
        ? `${host.relOf(fileName)}:${lc.line + 1}:${lc.character + 1}`
        : host.relOf(fileName);
      return `${where} ${why}`;
    };

    const out: string[] = [];
    // Forward capture: a site we rewrote no longer resolves to the renamed symbol.
    for (const [l, s] of newTokenStart) {
      if (!postSet.has(key(l.fileName, s))) {
        out.push(
          describe(
            l.fileName,
            s,
            '(rewritten reference now binds to a different in-scope binding)',
          ),
        );
      }
    }
    // Reverse capture: a pre-existing token literally spelled `newName` now binds to the renamed
    // symbol. Guards: (1) only files WE edited can hold such a token (an un-edited file still has
    // the old name); (2) it must be spelled `newName` — the symbol's OTHER references reached via an
    // alias (`import {x as sg}` … `sg()`) are legitimately NOT rewritten and are NOT captures, so
    // skip any post-reference whose text isn't `newName` (this was the over-refusal trap).
    const editedFiles = new Set(changes.map((c) => host.absOf(c.path)));
    for (const r of post) {
      if (!editedFiles.has(r.fileName) || mineSet.has(key(r.fileName, r.textSpan.start))) continue;
      const text = program?.getSourceFile(r.fileName)?.text;
      if (
        text === undefined ||
        text.slice(r.textSpan.start, r.textSpan.start + newName.length) !== newName
      ) {
        continue; // an aliased / differently-spelled reference — not a reverse capture
      }
      out.push(
        describe(
          r.fileName,
          r.textSpan.start,
          '(a pre-existing reference here now binds to the renamed symbol)',
        ),
      );
    }
    return out;
  } finally {
    host.clearOverlay();
  }
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
