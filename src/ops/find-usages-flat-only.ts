// The groupBy disclosures for `find_usages`'s FLAT-ONLY annotations (`destructures` /
// `conditions` / the `props` per-site values): a rollup row is not a per-site view, so each
// requested annotation that cannot apply is named — never silently swallowed (§3.6). Split from
// the op module to keep it under the line cap.

import { defineLesson } from '../common/lesson/lesson.ts';

/** Under groupBy the `props` FILTER still applies (it runs before the rollup — the sweep question
 *  is answered), but the per-site value annotation has no home on an encloser row; say which half
 *  was dropped rather than let the absence read as "no props matched" (§3.6). */
export const GROUPBY_LESSONS = [
  defineLesson({
    id: 'groupby-props',
    full: 'props filter applied before the rollup; per-site prop VALUES are a flat-mode annotation — drop groupBy to read them',
    short: 'props filter applied; per-site values need flat mode',
  }),
  defineLesson({
    id: 'groupby-destructures',
    full: 'destructures ignored — a per-call-site return-shape is a flat-mode annotation; drop groupBy to see it',
    short: 'destructures ignored under groupBy',
  }),
  defineLesson({
    id: 'groupby-conditions',
    full: 'conditions ignored — a per-site enclosing-condition chain is a flat-mode annotation; drop groupBy to see it',
    short: 'conditions ignored under groupBy',
  }),
] as const;
const [PROPS_GROUPBY, DESTRUCTURES_GROUPBY, CONDITIONS_GROUPBY] = GROUPBY_LESSONS;
const PROPS_GROUPBY_NOTE = PROPS_GROUPBY.full;
const DESTRUCTURES_GROUPBY_NOTE = DESTRUCTURES_GROUPBY.full;
const CONDITIONS_GROUPBY_NOTE = CONDITIONS_GROUPBY.full;
type FlatOnlyArgs = {
  destructures?: boolean | undefined;
  conditions?: boolean | undefined;
  props?: unknown;
  groupBy?: unknown;
};
/** The disclosure lines for every flat-only flag this call set under groupBy (empty when none). */
export function flatOnlyIgnored(args: FlatOnlyArgs): string[] {
  if (args.groupBy === undefined) return [];
  const notes: string[] = [];
  if (args.destructures === true) notes.push(DESTRUCTURES_GROUPBY_NOTE);
  if (args.conditions === true) notes.push(CONDITIONS_GROUPBY_NOTE);
  if (args.props !== undefined) notes.push(PROPS_GROUPBY_NOTE);
  return notes;
}
