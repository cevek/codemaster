// The groupBy disclosures for `find_usages`'s FLAT-ONLY annotations (`destructures` /
// `conditions` / the `props` per-site values): a rollup row is not a per-site view, so each
// requested annotation that cannot apply is named — never silently swallowed (§3.6). Split from
// the op module to keep it under the line cap.

import { PROPS_GROUPBY_NOTE } from './find-usages-props.ts';

const DESTRUCTURES_GROUPBY_NOTE =
  'destructures ignored — a per-call-site return-shape is a flat-mode annotation; drop groupBy to see it';
const CONDITIONS_GROUPBY_NOTE =
  'conditions ignored — a per-site enclosing-condition chain is a flat-mode annotation; drop groupBy to see it';
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
