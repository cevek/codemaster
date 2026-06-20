// Renderers for the mutating-op disclosure rows: a capture-safety refusal site, and the
// rename old-name-survivor report.

import type { ShapeRenderer } from './types.ts';
import { asArray, flat } from './helpers.ts';

/** Capture row (rename/move/extract/codemod capture-safety refusal): { at, kind, detail }.
 *  `at` is the clickable file:line:col; `detail` carries spaces. One line, not a 3-line block. */
export const capture: ShapeRenderer = (v) =>
  `${String(v['at'])} · ${String(v['kind'])} · ${flat(v['detail'])}`;

/** rename oldNameSurvives: { summary, reExportAliases[], exportStarConsumers[] }. The summary
 *  states the counts; the (already-condensed) survivor spans ride beneath as proof, as a
 *  multi-line string — no bare k=v at depth. */
export const nameSurvives: ShapeRenderer = (v) => {
  const aliases = asArray(v['reExportAliases']).map(String);
  const consumers = asArray(v['exportStarConsumers']).map(String);
  const lines = [String(v['summary'])];
  if (aliases.length > 0) lines.push(`  re-export aliases: ${aliases.join(' | ')}`);
  if (consumers.length > 0) lines.push(`  via export*: ${consumers.join(' | ')}`);
  return lines.join('\n');
};
