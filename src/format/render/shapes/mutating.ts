// Renderers for the mutating-op disclosure rows: a capture-safety refusal site, and the
// rename old-name-survivor report.

import type { ShapeRenderer } from './types.ts';
import { asArray, flat, spanLoc } from './helpers.ts';

/** Capture row (rename/move/extract/codemod capture-safety refusal): { at, kind, detail }.
 *  `at` is the clickable file:line:col; `detail` carries spaces. One line, not a 3-line block. */
export const capture: ShapeRenderer = (v) =>
  `${String(v['at'])} · ${String(v['kind'])} · ${flat(v['detail'])}`;

/** rename oldNameSurvives: { summary, reExportAliases[], exportStarConsumers[] }. The summary
 *  states the counts; the (already-condensed) survivor spans ride beneath as proof, as a
 *  multi-line string — no bare k=v at depth. */
export const nameSurvives: ShapeRenderer = (v) => {
  // reExportAliases / exportStarConsumers are condensed proof SPANS — a string at terse/normal, a
  // verbatim OBJECT at full; spanLoc collapses each to its loc so neither stringifies to `[object
  // Object]` (this is a collapse-disposition disclosure row — the body is not the proof here).
  const aliases = asArray(v['reExportAliases']).map((s) => spanLoc(s));
  const consumers = asArray(v['exportStarConsumers']).map((s) => spanLoc(s));
  const lines = [String(v['summary'])];
  if (aliases.length > 0) lines.push(`  re-export aliases: ${aliases.join(' | ')}`);
  if (consumers.length > 0) lines.push(`  via export*: ${consumers.join(' | ')}`);
  return lines.join('\n');
};

/** One `summaryOnly` touched-file stat row — the single list that replaces the redundant
 *  bare-`touched` + keyed-`diffstat` pair. A written file is `{ path, added, removed }` →
 *  `path · +A -R`; a moved-away / deleted source is `{ path, gone:true }` → `path · (removed)`
 *  (the marker that keeps move_file's moved-away sources visible — §3.4 completeness). */
export const touchedStat: ShapeRenderer = (v) =>
  v['gone'] === true
    ? `${String(v['path'])} · (removed)`
    : `${String(v['path'])} · +${String(v['added'])} -${String(v['removed'])}`;
