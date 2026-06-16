// The capture-safety primitive shared by every mutating refactor (§ spec-refactor-capture-safety).
// A CAPTURE is a reference/import the mutation rewrote that — after the edit — no longer resolves
// to the SAME symbol/module it did before (forward), or a pre-existing token that now silently
// binds to the mutated symbol (reverse). It is type-compatible, so the §2.8 typecheck cannot see
// it; it is not a redeclaration, so the LS does not flag it. Each flavor (rename / move+extract /
// codemod) detects it over the POST-EDIT overlay and reports the proof-carrying site here.

import type { RepoRelPath } from '../../../../core/brands.ts';

export interface Capture {
  /** Repo-relative path of the captured site (proof location). */
  file: RepoRelPath;
  /** 1-based line/col; 0 when the position could not be located in the post-edit program
   *  (we still report the file rather than drop the capture — §3.4). */
  line: number;
  col: number;
  /** `forward` — a site WE rewrote now binds to a different symbol/module; `reverse` — a
   *  pre-existing token now binds to the mutated symbol. */
  kind: 'forward' | 'reverse';
  /** Human descriptor of why this site is a capture (rendered verbatim). */
  detail: string;
}
