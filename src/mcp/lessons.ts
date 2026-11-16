// The facade's lesson registry: everything below it plus the facade's own aggregate-cut marker.

import type { Lesson } from '../common/lesson/lesson.ts';
import { OP_LESSONS } from '../ops/lesson-catalogue.ts';
import { AGGREGATE_CAP_REMEDY } from './render-response.ts';

export const LESSONS: readonly Lesson[] = [...OP_LESSONS, AGGREGATE_CAP_REMEDY];

/** `status {concept:"<id>"}`: the full text, whatever this session has or has not seen. */
export function conceptText(id: string): string {
  const lesson = LESSONS.find((l) => l.id === id);
  if (lesson !== undefined) return `[${lesson.id}] ${lesson.full}`;
  return `concept '${id}' unknown — ids: ${LESSONS.map((l) => l.id).join(', ')}`;
}
