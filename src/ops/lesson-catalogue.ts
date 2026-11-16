// Every lesson an op, plugin or renderer emits (§12 prose folding) — the one list the MCP facade
// folds against and `status {concept}` expands from. Lives in ops/ because it is the lowest layer
// that may import all of plugins/ and format/.

import type { Lesson } from '../common/lesson/lesson.ts';
import { CONCEPT_LESSONS } from '../format/render/concepts.ts';
import { RENDER_LESSONS } from '../format/render/render-lessons.ts';
import { PRE_EDIT_LESSONS } from '../format/render/render-status.ts';

export const OP_LESSONS: readonly Lesson[] = [
  ...PRE_EDIT_LESSONS,
  ...RENDER_LESSONS,
  ...CONCEPT_LESSONS,
];
