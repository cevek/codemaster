// Shared overlay-resolve scaffolding for the capture detectors. Every flavor resolves
// references/imports over the POST-EDIT overlay through the LS (it handles aliases / overloads /
// shorthand / the project's own module resolution), then compares to the pre-edit truth. The
// overlay is ALWAYS cleared in a `finally` so it never leaks into a later read as a fact (§2.4).

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import type { Capture } from './types.ts';

/** One file's post-edit content, addressed by absolute path (already toPosix-normalized by the
 *  host's `setOverlay`). */
export interface OverlayEntry {
  abs: string;
  content: string;
}

/** Run `fn` with `entries` overlaid (and `removed` paths tombstoned), ALWAYS clearing the
 *  overlay afterward — bounded, self-contained, never a stale window. */
export function withOverlay<T>(
  host: TsProjectHost,
  entries: readonly OverlayEntry[],
  removed: readonly RepoRelPath[],
  fn: () => T,
): T {
  host.setOverlay(entries, removed);
  try {
    return fn();
  } finally {
    host.clearOverlay();
  }
}

/** Build a `Capture` from a 0-based offset in `fileName`, resolved to 1-based line:col via the
 *  given program (the post-edit bytes the agent will see). A missing source file degrades to
 *  line/col 0 — the file is still named, never a dropped capture (§3.4). */
export function captureAt(
  host: TsProjectHost,
  program: ts.Program | undefined,
  fileName: string,
  start: number,
  kind: Capture['kind'],
  detail: string,
): Capture {
  const sf = program?.getSourceFile(fileName);
  const lc = sf ? sf.getLineAndCharacterOfPosition(start) : undefined;
  return {
    file: host.relOf(fileName),
    line: lc ? lc.line + 1 : 0,
    col: lc ? lc.character + 1 : 0,
    kind,
    detail,
  };
}

/** The declaration a position resolves to — its `{ fileName, start }`, or `undefined` when nothing
 *  resolves. Uses `getDefinitionAtPosition` (the LS's own resolver), so aliases / re-exports /
 *  overloads collapse to the real declaration. The offset is in WHATEVER program state is active
 *  (disk pre-edit, or the overlay post-edit) — callers comparing across states must normalize the
 *  offset to a common space first (else a merely-shifted same symbol reads as a different one). */
export function declarationDefAt(
  host: TsProjectHost,
  fileName: string,
  pos: number,
): { fileName: string; start: number } | undefined {
  const def = host.service.getDefinitionAtPosition(fileName, pos)?.[0];
  if (def === undefined) return undefined;
  return { fileName: def.fileName, start: def.textSpan.start };
}
