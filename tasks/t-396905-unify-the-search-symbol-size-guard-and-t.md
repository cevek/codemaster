---
id: t-396905
title: Unify the search_symbol size guard and the semantic-fanout guard on the post-pruning peak (Σ program.fileNames) memory model — the semantic guard's total-surface estimate undercounts the real fan-out cost
status: backlog
priority: medium
parent: t-031282
depends_on:
  - t-399909
  - t-411303
tags:
  - multi-program
  - platform
type: imp
complexity: M
area: platform
created: '2026-07-17T10:30:42.845Z'
---
Surfaced by t-399909 during the pruning-aware size-guard work. Deferred to avoid two live tracks (t-399909 + t-411303) editing the shared `semantic-fanout-guard.ts` + its test file concurrently.

## The latent undercount
The semantic-fanout guard (t-679091) gates on `estimateSourceFileCount` — the git source SURFACE (distinct files under root, ~6105 on backoffice2). But the real memory cost of a fan-out op (find_usages/impact/importers_of — they NEVER prune, they fan the LS across every program via `programsContaining`) is `Σ program.fileNames` with overlap (~18311 on backoffice2), because each program builds its own checker (per-program overhead ~0.33 MB/file, measured in t-399909). So the surface estimate UNDER-counts the real fan-out peak by ~3×.

It's currently SAFE only because the threshold (4000) is conservative enough that backoffice2's surface (6105) still exceeds it → honest refuse. But it's the wrong physical model: raise the threshold and the undercount becomes an OOM hole (exactly why t-399909 had to use a SEPARATE threshold rather than raise the shared one).

## The fix (single owner, after t-399909 + t-411303 land)
Move the semantic-fanout guard onto the same `estimateSearchPeak` model t-399909 built (for a non-prunable op, pruned=false → peak = Σ program.fileNames = the exact fan-out cost). Then ONE threshold (post-pruning peak, ~8000) is correct for BOTH guards:
- search_symbol backoffice2: prunes → peak 6107 < 8000 → warms ✓
- find_usages backoffice2: Σ=18311 > 8000 → refuse ✓ (more accurate than the current surface-undercount)

Collapses the two thresholds (searchWarmMaxFiles + the new searchWarmPeakMaxFiles from t-399909) back into one peak-based knob, and fixes the semantic guard's undercount. Update the shared `semantic-fanout-guard.ts` + `test/differential/semantic-fanout-guard.test.ts` in one owner pass (both prerequisite tracks merged → no concurrent editing). doc-sync the config semantics.
