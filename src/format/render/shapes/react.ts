// `~shape` renderers for the `react` plugin's rows (§12). Dense one-liners; the row carries no
// verbatim proof body (a prop is `name: type` + a declaration location), so it collapses at `full`.

import type { ShapeRenderer } from './types.ts';
import { confTail, spanLoc } from './helpers.ts';

/** UnusedProp: { name, optional, inherited?, external?, type, confidence, span? } → `name[?]: type
 *  [(inherited)][(external)] @ decl-loc · confidence`. `external` (declared outside the repo's
 *  own source) is a DIFFERENT claim from `inherited` (heritage) — both render, neither implies
 *  the other. */
export const unusedProp: ShapeRenderer = (v) => {
  const opt = v['optional'] === true ? '?' : '';
  const inh = v['inherited'] === true ? ' (inherited)' : '';
  const ext = v['external'] === true ? ' (external)' : '';
  const loc = v['span'] !== undefined ? ` @ ${spanLoc(v['span'])}` : '';
  return `${String(v['name'])}${opt}: ${String(v['type'])}${inh}${ext}${loc}${confTail(v['confidence'])}`;
};
