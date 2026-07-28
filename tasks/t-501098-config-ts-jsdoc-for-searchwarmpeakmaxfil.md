---
id: t-501098
title: '`config.ts` jsdoc for `searchWarmPeakMaxFiles` still names the removed redirect targets (find_definition / find_usages) — the same lie as t-720379, one file over, addressed at whoever writes a config'
status: backlog
priority: low
tags:
  - docs
  - dogfood
type: bug
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-396905
surface:
  - core
  - docs
audience: both
evidence: repro
created: '2026-07-28T16:07:11.722Z'
---
Found by the doc track (t-720379) while sweeping for drift, left unfixed because it lives in `src/` and
the track was docs-only.

The jsdoc on `ts.searchWarmPeakMaxFiles` in `src/config/config.ts` enumerates the OLD redirect targets —
`find_definition` / `find_usages` — as what the guard sends the caller to. That guidance was removed
precisely because it pointed at ops that are themselves guarded or OOM on the repos where this threshold
fires: a refusal naming another refusal (t-959904).

Same defect class as the head task it was found under, one file over. The difference is the audience: this
text is read by whoever is authoring a `codemaster.config`, i.e. someone about to decide a threshold — so
it steers a configuration decision with a description of behaviour that no longer exists.

Fix is a comment: name what the guard actually redirects to now (`search_symbol {syntactic:true}` →
`symbols_overview {query}`), or drop the enumeration and point at `ops/guard/navigate.ts` as the single
home so it cannot drift again. Second form is preferable — the same reason the navigation table exists at
all.

Trivial in size; filed rather than fixed in place so it is not lost, since no current track owns
`src/config/**`.
