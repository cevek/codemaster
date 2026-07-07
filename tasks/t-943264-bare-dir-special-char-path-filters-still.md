---
id: t-943264
title: Bare-dir + special-char path filters still raw in scss (cascade/query.ts, plugin.ts) and i18n (plugin.ts) — reroute through matchesPathFilter chokepoint
status: backlog
priority: medium
depends_on:
  - t-019044
tags:
  - dogfood-jul
type: bug
complexity: S
area: correctness
created: '2026-07-07T22:24:28.793Z'
---
Residual from t-019044/t-310874. The wave-2 fix added a single path-filter chokepoint `common/glob/path-filter.ts` `matchesPathFilter` (bare-dir→prefix expand + glob-special-char escape) and routed the ts-plugin + ops sites (find_usages/unused_exports/construction_sites/impact/search/list) through it. But three sites still use raw `matchesAnyGlob` and thus retain the bare-dir silent-no-op + special-char bugs:
- src/plugins/scss/cascade/query.ts (inScope)
- src/plugins/scss/plugin.ts (unusedClasses)
- src/plugins/i18n/plugin.ts (~line 236, unusedKeys)

Trivial now that the chokepoint exists — each is a ~1-line reroute to `matchesPathFilter`. Left untouched in wave 2 because scss was being edited by a parallel track (Track E) and i18n is a separate domain (edit-disjoint discipline).
