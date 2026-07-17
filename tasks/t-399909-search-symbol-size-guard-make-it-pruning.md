---
id: t-399909
title: 'search_symbol size guard: make it pruning-aware (post-Fix-A over-refuses loose-root; naive raise re-OOMs references)'
status: done
priority: high
parent: t-031282
tags:
  - dogfood
  - multi-program
  - platform
type: bug
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-17T00:24:31.823Z'
---
## Context
Sub-step (a) of t-167395 (discovery pruning in `searchSymbols`, `plugins/ts/discovery-prune.ts`) is DONE: navto prunes to the primary program alone when the primary's built in-root source set ⊇ the in-root git source surface (`program.getCurrentDirectory()`-sourced, no host seam). Measured on backoffice2: default-heap `search_symbol {force:true}` now ~1.12 GB / ~19 s (cold CLI one-shot), no OOM (was 6.1 GB → hard V8 crash / exit 134). Byte-identical output vs a cold whole-repo navto oracle (test green).

## The residual: the t-333163 pre-warm size guard is now mis-calibrated
The guard (`plugins/ts/surface-size.ts::estimateSourceFileCount` + `ops/search-symbol.ts`) refuses the DEFAULT navto path when the total git source surface > `ts.searchWarmMaxFiles` (4000). Post-Fix-A this OVER-refuses the now-safe loose-root case: backoffice2 is 6083 files but the actual post-prune peak is a SINGLE ~1.1 GB program — well under default heap. So the default path still refuses a search that would now succeed cheaply; only `force:true` reaches the pruned path.

## Why "just gate on peak, not total" is subtler than it first looks
For a LOOSE-ROOT repo the post-prune peak IN FILE-COUNT ≈ the total surface (the primary globs the whole repo — 6083 files either way). The 6.1 GB → 1.1 GB win comes from program COUNT (25 → 1), NOT file count. Consequences:
- Simply RAISING `searchWarmMaxFiles` (e.g. 4000 → 15000) RE-INTRODUCES the OOM for a `references` monorepo: its total surface can be < the raised threshold, yet pruning does NOT engage there (the primary does not subsume), so the full multi-program fan-out still runs and sums to OOM.
- The guard runs PRE-warm and cannot cheaply know whether pruning will engage (subsumption needs the primary built + compared to the surface — the very warm it is guarding).
- Even the single primary program can OOM on a truly huge FLAT repo (~50k files), so a threshold must still exist — calibrated to single-program capacity, not removed.

## Design directions (pick one — needs measurement across repo shapes)
1. Two-tier guard: (a) gate the PRIMARY warm on the primary's own program file count (single-program capacity, higher threshold ~12–15k ≈ 2–3 GB); (b) after primary+prune, if the query still needs a multi-program fan-out (primary did not subsume), estimate the fan-out cost and refuse THERE. Correct but moves guard logic into the search path.
2. Cheap subsumption heuristic pre-warm (root tsconfig has no `references` + a whole-repo/loose include → single-program peak → allow up to the raised single-program threshold; else keep the conservative total-surface refuse). A config-shape heuristic — acceptable for a perf guard (not a correctness gate), but must be validated it never allows a fan-out that OOMs.
3. Leave the guard as-is and only advertise `force:true` as the escape (status quo; documents the over-refusal but doesn't fix it).

## Acceptance
- Loose-root monorepo (backoffice2 shape) default `search_symbol` WARMS and returns (no refuse) at default heap without OOM.
- A `references`/multi-package monorepo whose full fan-out would OOM is STILL refused (no regression of the t-333163 protection).
- Threshold(s) calibrated against a measured file-count → single-program-RSS curve, not guessed.
- Touches t-333163 code (`surface-size.ts` / `search-symbol.ts`) — confirm t-333163 is closed/inactive before editing.

## Repro / measurement harness
`/usr/bin/time -l node [--max-old-space-size=N] src/bin.ts op search_symbol '{"query":"VirtualSetup","force":true}' --root /Users/cody/Dev/backoffice2` (CLI one-shot, never MCP — a crash kills the shared daemon). Backoffice2 loose-root peak ≈ 1.12 GB / 6083 files.
