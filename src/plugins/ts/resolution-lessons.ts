// Repeated explanations of the ts plugin's resolution floors and misses (§12 session folding): the
// producers state their facts (counts, packages, names, files) and then these verbatim.

import { defineLesson } from '../../common/lesson/lesson.ts';

export const RESOLUTION_LESSONS = {
  workspaceUnresolvedWhy: defineLesson({
    id: 'workspace-unresolved',
    full: ' (no node_modules link, and none the declared dependencies make certain — an undeclared or non-`workspace:` dependency, or an entry into an unbuilt output);',
    short: ' (no link resolves them);',
  }),
  workspaceNoRemedy: defineLesson({
    id: 'workspace-unresolved-remedy',
    full: 's reached through them were NOT counted. No in-tool remedy — grep these specifiers.',
    short: 's reached through them were NOT counted.',
  }),
  emulatedLinks: defineLesson({
    id: 'emulated-links',
    full: " resolved through EMULATED workspace links — this tree has no node_modules link for them, so the project's own tsc run on it does NOT resolve them. Facts across those imports hold for an installed tree (links as the declared `workspace:` dependencies make them).",
    short: ' resolved through EMULATED workspace links — the tree’s own tsc does NOT resolve them.',
  }),
  nameMissNotProof: defineLesson({
    id: 'name-miss-not-proof',
    full: ' — check the name/file, or pass file:line:col. NOTE: this is NOT proof of absence — a destructured binding / namespace import-export / object-literal property is declared yet missed by THIS lookup.',
    short:
      ' — NOT proof of absence (a destructured / namespace / object-literal declaration is missed here).',
  }),
  nameMissBare: defineLesson({
    id: 'name-miss-bare',
    full: "' (no file) may find it, though it can land a same-named symbol elsewhere; to check without a name, address by position (file:line:col)",
    short: "' (no file) may find it; or address by position",
  }),
  nameMissFloor: defineLesson({
    id: 'name-miss-floor',
    full: "' declared in this file below or beside what this top-level lookup anchors (a floor: overload signatures, plain parameters and computed names TS does not key are not listed):",
    short: "' declared in this file beside the top-level anchors (a floor):",
  }),
  nameMissLineOnly: defineLesson({
    id: 'name-miss-line-only',
    full: ' An entry given by line only is one go-to-definition at its name did not return (it resolves through a contextual type / import source, or to nothing), so a position there does not print it.',
    short: ' A line-only entry has no position that prints it.',
  }),
} as const;
