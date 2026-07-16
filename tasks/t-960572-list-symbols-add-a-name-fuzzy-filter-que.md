---
id: t-960572
title: 'list_symbols: add a name/fuzzy filter (`query` arg) — reuse the syntactic createPatternMatcher so a multi-thousand-name catalogue narrows by NAME, not just path/kind (OOM-safe)'
status: done
priority: medium
tags:
  - dogfood
  - ts-core
type: feat
complexity: M
area: ts-core
source: dogfood-jul
created: '2026-07-16T12:21:16.760Z'
---
**Bundle — four cheap facets on `list_symbols`'s existing no-program syntactic scan (all OOM-safe, all orientation-semantic). Live dogfood on backoffice2 (14 tsconfig groups, 7278 exported names) motivated it.**

The op already parses the syntactic surface, knows each name's kind + owning file, groups per tsconfig, and dedups globally — so all of the below are derivable from that one pass with no new heavy machinery and NO LS warm.

**1. `query` — name/fuzzy filter (the anchor).** Reuse the SAME `createPatternMatcher` the `search_symbol {syntactic:true}` path uses (navto's project-agnostic matcher, §4), applied to the parsed name catalogue BEFORE the per-group cap. `list_symbols {query:'Clinic'}` → catalogue narrowed to the Clinic* family, still grouped, still capped-with-honesty, still OOM-safe. Verified this exact matcher works here (`ClinRow` → the ClinicRow* family) while default navto OOM-crashed the daemon (t-167395).

**2. `summary` — count facet (cheapest, best first-contact signal).** We already count. Surface a histogram BEFORE the names: `names: 7278 · const 4200 · type 1800 · interface 900 · function 380` + per-group totals. Counts are of the FULL set (never the capped subset). Answers "how big / what shape" before drilling. A `summaryOnly`/`summary:true` flag (names omitted) or a leading line.

**3. Duplicate/collision surfacing (`×N` annotation and/or `duplicatesOnly`).** The dedup step already knows a name declared in ≥2 distinct places. Annotate `mapEffort ×2`, or a `duplicatesOnly` mode listing only cross-file/cross-package name collisions. These are exactly the ambiguous-name landmines that later make `find_usages {name}` hard-FAIL (the `mapEffort ×2` case a dogfood agent hit). Free from the dedup pass; pure orientation ("what's ambiguous here").

**4. `kind` accepts an array** (`kind:['interface','type']`) — trivial.

**Explicitly NOT in scope (breaks the op's semantics/density):** per-name kind tags (`Foo:const`) — kills the "thousands of bare names in one output" density; `file:line` beside a name — that's the deliberate omission, the follow-up is `search_symbol`/`find_definition`; anything that warms the LS or shells to git — breaks OOM-safe.

Boundary: `src/ops/list-symbols.ts` + `src/plugins/ts/syntactic-catalogue.ts` (+ `syntactic-surface.ts` / `program/config-membership.ts` if needed); reuse `createPatternMatcher` from the syntactic-search path (don't duplicate).

Source: live dogfood 2026-07-16 on /Users/cody/Dev/backoffice2. Relates: t-143952 (the op), t-515730 (the matcher it reuses), t-167395 (why OOM-safe matters).
