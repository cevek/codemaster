// Symbol-anchored rename via the LanguageService (spec Stage D, ports rename.ts). The LS
// resolves the symbol and returns every semantic reference site — aliased imports, JSX,
// re-exports — that a textual replace would miss or over-match. We turn those sites into a
// per-file before/after pair (the edit substrate reuses Stage A's `applyEdits`, so the
// rename inherits its overlap/ordering guarantees). Whether the NEW name is legal is NOT
// decided here — the post-edit typecheck (§2.8) is the oracle for that (e.g. a collision
// with an existing binding surfaces as a duplicate-identifier diagnostic), never a guess.

import type { TsProjectHost } from '../../ls-host.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';

export interface RenameChange {
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
  return { changes, dropped };
}
