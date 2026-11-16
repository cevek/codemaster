// What ONE MCP connection has already been shown in full (§12 "prose folding"). Lives only in the
// facade: the `Result`, `format:'json'`, sql tables, the CLI and a cold daemon never see it. A lesson
// counts as shown only if its full text is in the FINAL response — after the per-op cap, the batch
// aggregate cut and the seam cap — so a cut never leaves the reader with folds of text it never got.

import { lessonRef, type Lesson } from '../common/lesson/lesson.ts';
import { identityFold, type ProseFold } from '../format/render/fold-prose.ts';

export interface ResponseFolder {
  /** The fold for one section answered against `root` (request root ?? tool root ?? cwd, raw). */
  foldFor(root: string): ProseFold;
  /** Re-expand the first fold of a lesson whose kept full copy did not survive the render caps. */
  repair(renderedText: string): string;
  /** Record what the final, capped response text actually delivered. */
  commit(finalText: string): void;
}

export interface SessionMemory {
  beginResponse(): ResponseFolder;
  /** Mark free-standing text (e.g. a `status` render) as delivered. */
  shownIn(finalText: string): void;
  isShown(lesson: Lesson): boolean;
}

export const noFolding: ResponseFolder = {
  foldFor: () => identityFold,
  repair: (text) => text,
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
      // Keys kept in full in THIS response; root-scoped ones grouped by lesson so a multi-root
      // response commits them only when every kept copy survived the cuts.
      const kept = new Map<Lesson, Set<string>>();
      const fold = (s: string, root: string): string => {
        if (s.length < minLength) return s;
        let out = s;
        for (const lesson of lessons) {
          if (!out.includes(lesson.full)) continue;
          const key = keyOf(lesson, root);
          const parts = out.split(lesson.full);
          let rebuilt = parts[0] ?? '';
          for (let i = 1; i < parts.length; i++) {
            const keys = kept.get(lesson) ?? new Set<string>();
            const keep = !shown.has(key) && !keys.has(key);
            if (keep) kept.set(lesson, keys.add(key));
            rebuilt += (keep ? lesson.full : lessonRef(lesson)) + (parts[i] ?? '');
          }
          out = rebuilt;
        }
        return out;
      };
      return {
        foldFor: (root) => (s) => fold(s, root),
        repair(text) {
          // A cap may have cut the one full copy this response kept; a later fold of it (later in
          // the section, or in a later section) would then point at text the reader never got.
          let out = text;
          for (const lesson of kept.keys()) {
            const ref = lessonRef(lesson);
            if (out.includes(lesson.full) || !out.includes(ref)) continue;
            out = out.replace(ref, lesson.full);
          }
          return out;
        },
        commit(finalText) {
          shownIn(finalText);
          for (const [lesson, keys] of kept) {
            if (lesson.scope !== 'root') continue;
            if (finalText.split(lesson.full).length - 1 >= keys.size) {
              for (const k of keys) shown.add(k);
            }
          }
        },
      };
    },
  };
}
