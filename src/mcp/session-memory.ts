// What ONE MCP connection has already been shown in full (§12 "prose folding"). Lives only in the
// facade: the `Result`, `format:'json'`, sql tables, the CLI and a cold daemon never see it. A lesson
// counts as shown only if its full text is in the FINAL response — after the per-op cap, the batch
// aggregate cut and the seam cap — so a cut never leaves the reader with folds of text it never got.

import { lessonRef, type Lesson } from '../common/lesson/lesson.ts';
import { identityFold, type ProseFold } from '../format/render/fold-prose.ts';

export interface ResponseFolder {
  /** The fold for one section answered against `root` (request root ?? tool root ?? cwd, raw). */
  foldFor(root: string): ProseFold;
  /** Resolve this response's folds: each becomes `short [id]`, except the first fold of a lesson
   *  whose kept full copy did not survive the render caps, which becomes the full text. REQUIRED on
   *  every text this response produced before it is sent. */
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

// A fold is written as a placeholder of the ref's length (so the render caps measure what the reader
// gets) in private-use characters no producer emits, and resolved by `repair` after all caps but the
// seam's.
const OPEN = String.fromCharCode(0xe000);
const PAD = String.fromCharCode(0xe001);
const PLACEHOLDER = new RegExp(`${OPEN}([a-z-]+)${PAD}+`, 'g');

function placeholder(lesson: Lesson): string {
  const head = `${OPEN}${lesson.id}${PAD}`;
  return head + PAD.repeat(Math.max(lessonRef(lesson).length - head.length, 0));
}

export function createSessionMemory(lessons: readonly Lesson[]): SessionMemory {
  const shown = new Set<string>();
  const byId = new Map(lessons.map((l) => [l.id, l] as const));
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
            rebuilt += (keep ? lesson.full : placeholder(lesson)) + (parts[i] ?? '');
          }
          out = rebuilt;
        }
        return out;
      };
      return {
        foldFor: (root) => (s) => fold(s, root),
        repair(text) {
          // Folds are placeholders until here, so only positions the fold itself wrote are touched
          // — never a json section or data that happens to spell a ref. A cap may have cut the one
          // full copy this response kept; its first surviving fold then becomes the full text.
          const expand = new Set(
            [...kept.keys()].filter((l) => !text.includes(l.full)).map((l) => l.id),
          );
          return text.replace(PLACEHOLDER, (_m, id: string) => {
            const lesson = byId.get(id);
            if (lesson === undefined) return _m;
            if (expand.delete(id)) return lesson.full;
            return lessonRef(lesson);
          });
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
