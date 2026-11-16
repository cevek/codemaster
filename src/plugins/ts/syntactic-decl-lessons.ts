// The syntactic declaration path's repeated miss explanations (§12 session folding). A miss message
// states its facts (the name, the file, the position) and then one of these verbatim.

import { defineLesson } from '../../common/lesson/lesson.ts';

export const SYNTACTIC_DECL_LESSONS = {
  mergeCaveat: defineLesson({
    id: 'decl-merge-caveat',
    full: 'this path cannot tell separate symbols from ONE symbol declared in several places (a namespace / declare-global merge, a function-scoped var; that needs the checker)',
    short: 'separate symbols vs one merged symbol is not told apart here',
  }),
  pickOne: defineLesson({
    id: 'decl-pick-one',
    full: 'pick the one you mean: pass one of these SymbolIds, or name+file / file:line:col',
    short: 'pick one (SymbolId / name+file / file:line:col)',
  }),
  handleOffSurface: defineLesson({
    id: 'decl-handle-off-surface',
    full: ' — this is NOT proof it is gone (an outside-root tsconfig include is not scanned here); drop syntactic:true to resolve it through the checker',
    short: ' — NOT proof it is gone',
  }),
  noDeclarationAt: defineLesson({
    id: 'decl-none-at',
    full: " — the syntactic path prints the declaration AT an address and cannot follow a reference to its definition (that needs the checker). Pass the declaration's own position, or drop syntactic:true.",
    short: ' — a reference is not followed here; pass the declaration position',
  }),
  noNameInFile: defineLesson({
    id: 'decl-none-in-file',
    full: " by the syntactic scan — check the name/file (a member is indexed under its KEY, so `[Symbol.iterator]` is reachable as 'iterator' and `'a-b'` as 'a-b'), or pass file:line:col. NOTE: this is NOT proof of absence — a declaration whose name is computed at runtime (`[key]`, `[${expr}]`) is indexed under no name at all, so no name can reach it; address it by position.",
    short: ' by the syntactic scan — NOT proof of absence (a computed name has no key)',
  }),
  noNameOnSurface: defineLesson({
    id: 'decl-none-on-surface',
    full: ' in the scanned source surface under the workspace root. An outside-root tsconfig include/reference is not scanned here — drop syntactic:true for those.',
    short: ' in the scanned source surface (outside-root includes not scanned)',
  }),
} as const;
