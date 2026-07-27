---
id: t-140062
title: Doc drift ARCHITECTURE.md §9:938 — claims the SEMANTIC ops are NOT size-gated, but semantic-fanout-guard.ts gates them in-process
status: done
priority: medium
tags:
  - docs
  - dogfood
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-27T22:19:05.026Z'
---
ARCHITECTURE.md §9 (pre-warm size guard, line ~938) states:

> "…and the SEMANTIC ops (`find_usages`/`find_definition`, which NEED the LS and have no cheap
> substitute) are NOT gated — their fix is process-isolation (§2)."

`src/ops/guard/semantic-fanout-guard.ts` (t-679091, done) contradicts this: `find_usages` / `impact` /
`importers_of` / bare-name `find_definition` DO refuse under `isolation:'in-process'` (the default) once
`estimateSourceFileCount() > searchWarmMaxFiles`. Confirmed live in `~/.codemaster/usage/fail.jsonl`:
`find_definition {"name":"Select"}` and `find_usages {symbols:[…]}` on `/Users/cody/Dev/backoffice2`
both return `FAIL tool=size-guard — repo is large (6098 source files > threshold 4000) …`.

An agent reading §9 concludes those ops always run and does not plan for the refusal — the doc lies about
current behavior. Rewrite §9 in present state: the semantic fan-out ops ARE gated, but ONLY in-process
(process-mode never refuses, it survives the OOM honestly), with `force:true` the per-call override.
Cross-check §2/§19 for the same claim.
