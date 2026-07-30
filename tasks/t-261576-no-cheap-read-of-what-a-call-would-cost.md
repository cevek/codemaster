---
id: t-261576
title: "No cheap read of what a call WOULD cost: the pre-warm peak estimate exists internally, so an agent learns an op's cost family by being killed by it"
status: backlog
priority: high
parent: t-338692
type: feat
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-187018
  - t-396905
  - t-533573
  - t-811950
  - t-980509
audience: external
evidence: measured
created: '2026-07-30T12:21:46.346Z'
---
## The asymmetry, measured on one repo in one session

On a 6.1k-file monorepo the cost of an answer spans four binary orders:

| call | live heap |
|---|---|
| `find_usages` (ANY addressing — bare name, file-pin, symbolId) | ~5.2 GB |
| `source` (file-pin, and bare name with 27 same-named decls) | ~0.9 GB |
| `symbols_overview` | ~0.2 GB |

**The tool knows which family a call belongs to. The agent learns it by getting killed.** There is no read
that answers "what would this cost here", so the only way to discover that a repo is over the line is to fire
a call that may take the engine down with it — and on the guard's own admission that is the case the guard
exists for.

## The estimate already exists

`search_symbol`'s pre-warm guard computes a peak internally (`estimateSearchPeak` → `{peakFiles, pruned}`),
and the discovery layer knows Σ per-program file-sets. Measuring it by hand required building an engine
(`createEngine` + `builtinPlugins`) and reading `v8.getHeapStatistics()` — roughly half of a measurement
harness that a cheap read would have replaced.

Surface it as a read: files that would build, whether the discovery prune engages, Σ per-program file-sets,
and the resulting cost family. Then an agent decides BEFORE firing, instead of after a `FAIL tool=oom`.

## Why this belongs to the capability epic rather than to observability

The epic's finding is that every existing mechanism made the REFUSAL more accurate and none made an ANSWER
possible. This one is the missing third option: not answering, and not refusing, but **letting the caller
choose the affordable question** — which is exactly what the redirect table (`ops/guard/navigate.ts`) tries to
do with prose, on structure it cannot measure. With a cost read, a refusal could name a call that is cheap
HERE rather than cheap by construction.

Keep the never-hang constraint in view (§1): the estimate must stay host-free and bounded — file COUNTS off
already-globbed sets, never a per-call tree scan, never a `getProgram()`. That is what the existing pre-warm
estimator already respects, so this is a surfacing task, not a new measurement path.
