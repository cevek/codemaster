---
id: t-138266
title: importers_of misfit-hint lives in the central name-keyed intake table, not a per-op OpIntake.moduleTarget flag — latent desync if importers_of later gains a query alias
status: in-progress
priority: medium
tags:
  - dogfood
  - intake
type: imp
complexity: S
area: render
source: dogfood-jul
created: '2026-07-15T18:21:27.321Z'
---
The `query`/`name`→module misfit reject for `importers_of` (the loud "takes a module PATH, not a symbol name" steer) is implemented in the central name-keyed table `src/ops/intake/misfit-hints.ts`, which runs BEFORE `applyAliases`. If someone later adds a `query` alias to `importers_of.intake.aliases`, the central misfit table silently wins → the alias never fires. Degradation is honest (generic bad_args, not a §3.6 lie), so this is maintainability, not correctness.

**Ask (arch-reviewer suggestion):** mirror the existing `OpIntake.locationTarget` pattern with a per-op `OpIntake.moduleTarget?` flag so the module-target discrimination is declared on the op, not in a central name-keyed table. Requires editing `src/ops/contracts.ts`/registry (`OpIntake` shape) — out of the original intake track's file boundary.

Source: track A (t-954279) DONE ⚑1, arch-reviewer.
