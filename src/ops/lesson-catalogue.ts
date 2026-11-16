// Every lesson an op, plugin or renderer emits (§12 prose folding) — the one list the MCP facade
// folds against and `status {concept}` expands from. Lives in ops/ because it is the lowest layer
// that may import all of plugins/ and format/.

import type { Lesson } from '../common/lesson/lesson.ts';
import { CONCEPT_LESSONS } from '../format/render/concepts.ts';
import { RENDER_LESSONS } from '../format/render/render-lessons.ts';
import { PRE_EDIT_LESSONS } from '../format/render/render-status.ts';
import { COMPONENTS_LESSON } from '../plugins/react/plugin.ts';
import {
  CONSTRUCTION_NOTES,
  DISCLOSURE_LESSONS,
  SYNTACTIC_DECL_LESSONS,
  SYNTACTIC_LESSONS,
  UNUSED_DEMOTE,
} from '../plugins/ts/plugin.ts';
import { AFFECTED_LESSONS } from './affected-lessons.ts';
import { IMPACT_TIMEOUT_LESSON } from './impact.ts';
import { NESTED_PLUGIN_LESSON } from './list-inactive-hint.ts';
import { PROGRAMS_LEVER_LESSONS } from './programs-lever.ts';
import { FILE_HINT_LESSON } from './search-file-hint.ts';
import { GROUPBY_LESSONS } from './find-usages-flat-only.ts';
import { PROPS_TEXT_LESSON } from './find-usages-props.ts';
import {
  ALL_PROGRAM_LESSON,
  IMPORTS_COLLAPSED_LESSON,
  MERGE_DECLS_LESSON,
} from './find-usages-view.ts';
import { SYNTACTIC_SOURCE_GIVES_LESSON } from './guard/navigate.ts';
import { LOWER_BOUND_LESSONS } from './lower-bound-note.ts';
import { UNINDEXED_ABSENCE_LESSON } from './no-symbol-hint.ts';
import { POST_APPLY_INCOMPLETE_LESSON } from './post-apply-verify.ts';
import { SCAN_COVERAGE_LESSONS } from './scan-coverage.ts';
import { SYNTACTIC_EXPORTED_ONLY_LESSON, SYNTACTIC_SEARCH_LESSON } from './search-symbol.ts';
import { SYNTACTIC_SOURCE_LESSON } from './source-syntactic.ts';
import {
  OVERVIEW_CATALOGUE_LESSON,
  OVERVIEW_DUP_LESSON,
  OVERVIEW_HISTOGRAM_LESSON,
} from './symbols-overview.ts';
import { RENDERED_BY_FLOOR_LESSON } from './trace-field-to-render.ts';
import { WIDENING_LESSONS, WIDENING_SKIP_LESSONS } from './trace-type-widening-scope.ts';
import { UNUSED_ENUMERATION_LESSON } from './unused-exports-scope.ts';

export const OP_LESSONS: readonly Lesson[] = [
  ...PRE_EDIT_LESSONS,
  ...RENDER_LESSONS,
  ...CONCEPT_LESSONS,
  ...SYNTACTIC_LESSONS,
  SYNTACTIC_SEARCH_LESSON,
  SYNTACTIC_EXPORTED_ONLY_LESSON,
  SYNTACTIC_SOURCE_LESSON,
  SYNTACTIC_SOURCE_GIVES_LESSON,
  OVERVIEW_HISTOGRAM_LESSON,
  OVERVIEW_DUP_LESSON,
  ...DISCLOSURE_LESSONS,
  ...LOWER_BOUND_LESSONS,
  UNINDEXED_ABSENCE_LESSON,
  ALL_PROGRAM_LESSON,
  IMPORTS_COLLAPSED_LESSON,
  MERGE_DECLS_LESSON,
  ...GROUPBY_LESSONS,
  PROPS_TEXT_LESSON,
  ...SCAN_COVERAGE_LESSONS,
  ...Object.values(WIDENING_LESSONS),
  UNUSED_ENUMERATION_LESSON,
  ...Object.values(UNUSED_DEMOTE),
  ...Object.values(CONSTRUCTION_NOTES),
  COMPONENTS_LESSON,
  RENDERED_BY_FLOOR_LESSON,
  POST_APPLY_INCOMPLETE_LESSON,
  OVERVIEW_CATALOGUE_LESSON,
  ...Object.values(SYNTACTIC_DECL_LESSONS),
  ...Object.values(AFFECTED_LESSONS),
  IMPACT_TIMEOUT_LESSON,
  NESTED_PLUGIN_LESSON,
  ...Object.values(PROGRAMS_LEVER_LESSONS),
  ...WIDENING_SKIP_LESSONS,
  FILE_HINT_LESSON,
];
