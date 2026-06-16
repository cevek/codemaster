// Capture detection for `rename_symbol` (the proven reference). The typecheck is NOT a
// sufficient oracle: if `newName` is already an in-scope binding at a rewritten site, the
// rewritten reference binds to THAT binding, not to the renamed symbol — silent semantic
// corruption (`slugify(x)`→`upper(x)` calls a local `upper`). It is type-compatible, so the §2.8
// gate stays clean; and it is NOT a duplicate-identifier, so the LS doesn't flag it. We let the
// LS resolve references over the POST-EDIT overlay (aliases / overloads / shorthand), then compare
// that reference set to the exact sites we rewrote: any divergence (either direction) is a
// capture. Anchor on the symbol's DECLARATION — it cannot be captured (it IS the renamed symbol).
// When the anchor can't be established we return empty — we never fabricate a refusal (§3); the
// typecheck guards that residual edge.

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import type { Capture } from './types.ts';
import { captureAt, withOverlay } from './overlay.ts';

/** Minimal post-edit file shape the detector needs — the renamed file's new content. */
export interface RenamedFile {
  path: RepoRelPath;
  after: string;
}

/** Captures where renaming to `newName` would silently re-bind a reference to a DIFFERENT symbol
 *  (forward) — or pull a pre-existing `newName` reference onto the renamed one (reverse). Empty
 *  when the rename is semantically clean. */
export function detectRenameCapture(
  host: TsProjectHost,
  abs: string,
  offset: number,
  newName: string,
  locations: readonly ts.RenameLocation[],
  changes: readonly RenamedFile[],
): Capture[] {
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

  return withOverlay(
    host,
    changes.map((c) => ({ abs: host.absOf(c.path), content: c.after })),
    [],
    () => {
      const post = host.service.getReferencesAtPosition(declDef.fileName, declNewStart);
      if (post === undefined) return [];
      const program = host.service.getProgram();
      const key = (f: string, s: number): string => `${f}|${s}`;
      const postSet = new Set(post.map((r) => key(r.fileName, r.textSpan.start)));
      const mineSet = new Set<string>();
      for (const [l, s] of newTokenStart) mineSet.add(key(l.fileName, s));

      const out: Capture[] = [];
      // Forward capture: a site we rewrote no longer resolves to the renamed symbol.
      for (const [l, s] of newTokenStart) {
        if (!postSet.has(key(l.fileName, s))) {
          out.push(
            captureAt(
              host,
              program,
              l.fileName,
              s,
              'forward',
              'rewritten reference now binds to a different in-scope binding',
            ),
          );
        }
      }
      // Reverse capture: a pre-existing token literally spelled `newName` now binds to the renamed
      // symbol. Guards: (1) only files WE edited can hold such a token (an un-edited file still has
      // the old name); (2) it must be spelled `newName` — the symbol's OTHER references reached via
      // an alias (`import {x as sg}` … `sg()`) are legitimately NOT rewritten and are NOT captures,
      // so skip any post-reference whose text isn't `newName` (this was the over-refusal trap).
      const editedFiles = new Set(changes.map((c) => host.absOf(c.path)));
      for (const r of post) {
        if (!editedFiles.has(r.fileName) || mineSet.has(key(r.fileName, r.textSpan.start)))
          continue;
        const text = program?.getSourceFile(r.fileName)?.text;
        if (
          text === undefined ||
          text.slice(r.textSpan.start, r.textSpan.start + newName.length) !== newName
        ) {
          continue; // an aliased / differently-spelled reference — not a reverse capture
        }
        out.push(
          captureAt(
            host,
            program,
            r.fileName,
            r.textSpan.start,
            'reverse',
            'a pre-existing reference here now binds to the renamed symbol',
          ),
        );
      }
      return out;
    },
  );
}
