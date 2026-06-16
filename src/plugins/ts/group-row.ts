// `GroupRow.site` is internal plumbing: the rollup records a representative reference
// span on each encloser so `impact` can point a value-flow `dynamic` boundary at the
// exact value-read token (not the encloser's name). It is NOT part of the agent-facing
// `find_usages`/`impact` listing. Stripping is LOAD-BEARING, not just denseness: the terse
// renderer (`format/render/condense.ts`) matches a `GroupRow` by its EXACT sorted key set,
// so a leaked `site` key would silently drop every encloser row to verbose rendering. Every
// `GroupRow` emit path routes through this one chokepoint before emit.

import type { GroupRow } from './query-types.ts';

/** A rollup row without the internal `site` span — the shape emitted to the agent. */
export function omitGroupSite(row: GroupRow): GroupRow {
  const { site: _site, ...rest } = row;
  return rest;
}
