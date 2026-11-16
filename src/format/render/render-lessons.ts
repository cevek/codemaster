// Lessons owned by the text renderer itself — prose it adds around an envelope (§12 prose folding).

import { defineLesson } from '../../common/lesson/lesson.ts';

export const FEEDBACK_FOOTER = defineLesson({
  id: 'feedback',
  full: "— blocked or missing a capability? file it: feedback({kind:'bug', title:'…', detail:'…'})",
  short: '— file gaps via feedback',
});

export const CAP_MARKER_REMEDY = defineLesson({
  id: 'output-capped',
  full: 'Narrow the query (lower limit, scope by file/dir), use terse, or project columns with sql — do NOT assume this is everything.',
  short: 'do NOT assume this is everything',
});

export const RENDER_LESSONS = [FEEDBACK_FOOTER, CAP_MARKER_REMEDY] as const;
