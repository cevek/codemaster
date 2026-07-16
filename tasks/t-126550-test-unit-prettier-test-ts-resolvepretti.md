---
id: t-126550
title: 'test/unit/prettier.test.ts: "resolvePrettier reports unavailable when project ships no prettier" fails — hoisted prettier leaks into a no-prettier fixture'
status: done
priority: medium
tags:
  - dogfood
  - testing
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-14T14:56:30.662Z'
---
## Repro (current main + baseline)
`node --test test/unit/prettier.test.ts` → `not ok - resolvePrettier reports unavailable when the project ships no prettier (no bundled fallback)` (1 fail / 6 pass). Reproduced deterministically on b07a96c AND on baseline 4bde0ae with identical node_modules (throwaway worktree) → **pre-existing, Track-1-independent** (the t-515730/syntactic merge touched neither `support/prettier/` nor this test). Filed after a verified repro on main (not a hypothesis).

## Cause (hypothesis, not yet code-confirmed)
The test builds a fixture project that ships NO prettier and asserts `resolvePrettier` reports `unavailable` (per §5-L1: prettier resolves from the project ONLY, no bundled fallback). But node module resolution walks UP the dir tree; the fixture's temp location resolves the REPO's own hoisted `prettier` install, so `resolvePrettier` finds one where the test expects none → the negative assertion fails. Environment-sensitive test isolation, not a product bug in `resolvePrettier` itself.

## Fix direction
Isolate the fixture from ancestor node_modules (mount under a temp root outside the repo tree, or stub the resolver's search base), so "project ships no prettier" is truly represented. Do NOT weaken the assertion — the §5-L1 no-bundled-fallback contract is real and must stay tested.

## Note
CI (clean checkout, no ancestor hoist) may pass this today — the failure surfaces on a dev machine whose node_modules layout leaks upward. Confirm behavior under CI conditions before deciding severity.
