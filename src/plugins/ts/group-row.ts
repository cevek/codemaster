// `GroupRow.site` is a representative reference span on each encloser — WHERE a reference
// actually is, distinct from the encloser's name token. `find_usages` SURFACES it (a group is
// then proof-carrying at the reference level; the terse renderer in `format/render/condense.ts`
// has a key set WITH `site`). `impact` STRIPS it via `omitGroupSite` below: it already pins the
// precise value-flow `dynamic` boundary at `site` separately, and a per-row span across a whole
// closure listing is noise (§12). Stripping is still load-bearing where applied — the terse
// renderer matches a `GroupRow` by its EXACT sorted key set, so impact's listing must carry the
// site-less key set. Any NEW `GroupRow` emit path must either strip site here OR add a matching
// condense branch, never leak an unrecognized key set.

import type { GroupRow } from './query-types.ts';

/** A rollup row without the internal `site` span — the shape emitted to the agent. */
export function omitGroupSite(row: GroupRow): GroupRow {
  const { site: _site, ...rest } = row;
  return rest;
}
