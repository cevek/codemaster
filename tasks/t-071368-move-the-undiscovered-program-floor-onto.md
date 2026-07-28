---
id: t-071368
title: 'Move the undiscovered-program floor onto the envelope disclosure: an unindexed nested tsconfig is the SECOND cause of the same unsafe claim, still hand-plumbed per op'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: imp
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-000075
  - t-002010
  - t-162650
  - t-316487
surface:
  - core
  - ops
  - plugins/ts
audience: both
evidence: reported
created: '2026-07-28T10:55:19.056Z'
---
`Result.disclosures` (`core/result.ts`) carries resolve-time claims an answer does NOT support, keyed
by a closed `UnsafeClaim` union. Its one member today —
`'target-is-the-only-symbol-of-this-name'` — is produced at the ts plugin's single resolve chokepoint
(`plugins/ts/disclose-resolution.ts`) for ONE cause: the LS's name→declaration page was cut inside the
exact-name bucket.

That claim has a SECOND cause with identical consequences: a nested tsconfig codemaster did not load
as a program (`undiscoveredProgramLabels()`). A DISTINCT same-named declaration may live under it,
unindexed — so the resolved target may be a mis-pick and any completeness the answer states is a
floor. Same assertion, different reason it is unsafe.

That cause is still hand-plumbed: `ops/no-symbol-hint.ts` `definitionFloor` is consumed by
`find_definition` and (via `usagesFloor`) `find_usages`, gated per op on a `nameOnly` condition each
op re-derives. `expand_type` / `impact` / `member_usages` / `source` resolve the same name in a repo
with an unloaded nested config and answer without the claim — the exact asymmetry the envelope channel
removed for the page-cut cause.

Work: emit `'target-is-the-only-symbol-of-this-name'` from the resolve chokepoint when a name target
(WITHOUT a file pin — a file-pinned resolution is exact and a cross-program twin is irrelevant to it)
resolves while `undiscoveredProgramLabels()` is non-empty, with the labels named in the `note`. The
existing `data`-level `complete:false` + `undiscoveredPrograms` fields stay: they are a set-level
verdict about the op's own payload, a narrower statement than the target-level claim.

Guard both directions with the arms `test/differential/envelope-disclosure.test.ts` already uses: the
five ops must agree on a name target under an unloaded config, and a file-pinned target must inherit
nothing.

Do NOT let the union grow a member that names the EVENT (`page-overflowed`, `program-unloaded`). The
type carries what is unsafe to CLAIM; the cause belongs in the note. A member named after a cause is
the signal that producer and consumer are drifting apart again.
