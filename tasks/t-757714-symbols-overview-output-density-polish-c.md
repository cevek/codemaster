---
id: t-757714
title: symbols_overview output density polish — config legend for duplicatesOnly, short group headers, tightened note, count-sorted groups (§12 house style, no info loss)
status: done
priority: medium
tags:
  - dogfood
  - render
type: imp
complexity: M
area: render
source: dogfood-jul
created: '2026-07-16T13:52:17.447Z'
---
**Live dogfood (backoffice2 + codemaster self):** the `symbols_overview` output has several §12 density violations — repeated long strings and always-on prose that bloat the agent-facing output. The op is complete/honest but not DENSE. Fix all in one render-layer pass; drop NO information and preserve every honesty signal (§3.4/§3.6).

1. **duplicatesOnly config legend.** Today each collision repeats the FULL tsconfig paths: `useMutation ×3 (test/fixtures/repos/react-query/tsconfig.json | test/fixtures/repos/trace-invalidation/tsconfig.json), useQuery ×3 (…same two paths…), …` — the same long paths ~20×. Replace with a one-line config LEGEND (short codes A/B/C → full path, emitted once) + code refs per entry: `configs: A=…/react-query, B=…/trace-invalidation` then `useMutation ×3 (A|B), useQuery ×3 (A|B), …`. Exactly the front-renamer house style (§12: short codes + one-line legend).

2. **Group headers: drop the redundant `/tsconfig.json` suffix.** `apps/attraction/tsconfig.json [317]:` → `apps/attraction [317]:` (dir form). Applies to the catalogue group headers, `subgroupByKind` `config › kind` lines, and `byConfig`. The `/tsconfig.json` repeats on every group and carries no signal (grouping is per-tsconfig, stated once).

3. **shared-config annotation.** `(shared: also in apps/attraction/tsconfig.test.json, tsconfig.json)` repeats long paths — shorten (short dir form, or reference the legend). Keep the signal (this file is shared across N configs), lose the verbosity.

4. **Tighten the `note=` prose.** Today a large paragraph is emitted on EVERY call (syntactic-not-verified caveat + exportedOnly caveat + histogram multi-bucket caveat + duplicatesOnly definition, all concatenated). Keep EVERY honesty signal (syntactic catalogue not type-verified; outside-root not covered; pick a name → search_symbol/find_definition; cap markers) but terse the wording, and gate the flag-specific caveats behind their flags — the histogram multi-bucket caveat only when countsOnly/summary; the duplicatesOnly definition only in duplicatesOnly mode; the exportedOnly caveat only relevant to the exported surface. Never a per-call wall of prose when the flags aren't active.

5. **Group ordering: sort by name-count descending** (biggest/primary config first) instead of by path. Orientation leads with the real project surface; small fixture/example groups sink to the bottom. Deterministic tie-break (path asc) for §16 cold==warm.

Constraints: render-layer changes (ops/symbols-overview*.ts + format/render shapes); regenerate golden (`UPDATE_GOLDEN`); §3.4 — NO information dropped silently (legend preserves configs, short headers preserve the dir, tightened note preserves every signal); §16 determinism (count-sort tie-break fixed); ≤300 lines/file. Verify: the honest catalogue is byte-smaller but carries the same facts; a live before/after eyeball shows dense output.

Source: live dogfood 2026-07-16. Relates: t-960572 (the facets), t-143952 (the op).
