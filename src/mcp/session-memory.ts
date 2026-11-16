// What ONE MCP connection has already been shown in full (§12 "prose folding"). Lives only in the
// facade: the `Result`, `format:'json'`, sql tables, the CLI and a cold daemon never see it. A lesson
// counts as shown only if its full text is in the response actually SENT — after the per-op cap, the
// batch aggregate cut and the seam cap — so a cut never leaves the reader with folds of text it never
// got.

import { lessonRef, type Lesson } from '../common/lesson/lesson.ts';
import { identityFold, type ProseFold } from '../format/render/fold-prose.ts';

export interface ResponseFolder {
  /** The fold for one section answered against `root` (request root ?? tool root ?? cwd, raw). */
  foldFor(root: string): ProseFold;
  /** Start (re)rendering this response: occurrence counting restarts, retry decisions are kept. */
  startAttempt(): void;
  /** After a render: did a cap cut a full copy this attempt kept? Then the next attempt keeps a
   *  LATER occurrence instead (or, with none left, leaves that lesson unfolded) — re-render. */
  retryFor(renderedText: string): boolean;
  /** Give up folding for this response: every occurrence renders in full. */
  unfoldAll(): void;
  /** Record what the sent response text delivered. */
  commit(sentText: string): void;
}

export interface SessionMemory {
  beginResponse(): ResponseFolder;
  /** Mark free-standing text (e.g. a `status` render) as delivered. */
  shownIn(finalText: string): void;
  isShown(lesson: Lesson): boolean;
}

export const noFolding: ResponseFolder = {
  foldFor: () => identityFold,
  startAttempt: () => undefined,
  retryFor: () => false,
  unfoldAll: () => undefined,
  commit: () => undefined,
};

export function createSessionMemory(lessons: readonly Lesson[]): SessionMemory {
  const shown = new Set<string>();
  const sessionLessons = lessons.filter((l) => l.scope === 'session');
  const minLength = Math.min(...lessons.map((l) => l.full.length));
  const keyOf = (lesson: Lesson, root: string): string =>
    lesson.scope === 'root' ? `${lesson.id}@${root}` : lesson.id;
  const shownIn = (finalText: string): void => {
    for (const l of sessionLessons) if (finalText.includes(l.full)) shown.add(l.id);
  };

  return {
    shownIn,
    isShown: (lesson) => shown.has(lesson.id),
    beginResponse() {
      // Across attempts: the first occurrence index a key may keep, and keys left unfolded.
      const minIndex = new Map<string, number>();
      const unfolded = new Set<string>();
      let foldNothing = false;
      // Per attempt: occurrences seen per key, and the kept occurrence per key (by lesson).
      let seen = new Map<string, number>();
      let kept = new Map<Lesson, Map<string, number>>();

      const decide = (lesson: Lesson, key: string): boolean => {
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        if (foldNothing || unfolded.has(key)) return true;
        if (shown.has(key)) return false;
        const keys = kept.get(lesson) ?? new Map<string, number>();
        if (keys.has(key) || index < (minIndex.get(key) ?? 0)) return false;
        kept.set(lesson, keys.set(key, index));
        return true;
      };

      const fold = (s: string, root: string): string => {
        if (s.length < minLength) return s;
        let out = s;
        for (const lesson of lessons) {
          if (!out.includes(lesson.full)) continue;
          const key = keyOf(lesson, root);
          const parts = out.split(lesson.full);
          let rebuilt = parts[0] ?? '';
          for (let i = 1; i < parts.length; i++) {
            rebuilt += (decide(lesson, key) ? lesson.full : lessonRef(lesson)) + (parts[i] ?? '');
          }
          out = rebuilt;
        }
        return out;
      };

      const survived = (text: string, lesson: Lesson, keys: Map<string, number>): boolean =>
        text.split(lesson.full).length - 1 >= keys.size;

      return {
        foldFor: (root) => (s) => fold(s, root),
        unfoldAll() {
          foldNothing = true;
        },
        startAttempt() {
          seen = new Map();
          kept = new Map();
        },
        retryFor(text) {
          let retry = false;
          for (const [lesson, keys] of kept) {
            if (survived(text, lesson, keys)) continue;
            for (const [key, index] of keys) {
              if ((seen.get(key) ?? 0) > index + 1) minIndex.set(key, index + 1);
              else unfolded.add(key);
            }
            retry = true;
          }
          return retry;
        },
        commit(sentText) {
          shownIn(sentText);
          for (const [lesson, keys] of kept) {
            if (lesson.scope === 'root' && survived(sentText, lesson, keys)) {
              for (const k of keys.keys()) shown.add(k);
            }
          }
        },
      };
    },
  };
}
