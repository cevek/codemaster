// `affected`'s repeated floor explanations (§12 session folding): each note states its count and
// file list, then one of these verbatim.

import { defineLesson } from '../common/lesson/lesson.ts';

export const AFFECTED_LESSONS = {
  unloaded: defineLesson({
    id: 'affected-unloaded',
    full: ' repo tsconfig(s) NOT loaded as programs (nested package, not adjacent / referenced) — tests under them are invisible to the import graph and NOT traced; set is a LOWER BOUND — run the full suite.',
    short: ' repo tsconfig(s) NOT loaded — their tests NOT traced; a LOWER BOUND.',
  }),
  deleted: defineLesson({
    id: 'affected-deleted',
    full: ' — their former importers cannot be traced from the post-change tree; their affected tests are NOT included — run the full suite.',
    short: ' — their affected tests are NOT included.',
  }),
  nonTs: defineLesson({
    id: 'affected-non-ts',
    full: ' changed file(s) outside the TS import graph (non-TS asset / config) — tests reaching them via non-TS imports are NOT traced; set is a LOWER BOUND.',
    short: ' changed file(s) outside the TS import graph — NOT traced; a LOWER BOUND.',
  }),
  outside: defineLesson({
    id: 'affected-outside-root',
    full: ' — not traced (a test under the root may import them); set is a LOWER BOUND — run the full suite.',
    short: ' — not traced; a LOWER BOUND.',
  }),
  queryFailed: defineLesson({
    id: 'affected-query-failed',
    full: ' — their importers are NOT traced; affected-test set is a LOWER BOUND — run the full suite.',
    short: ' — importers NOT traced; a LOWER BOUND.',
  }),
} as const;
