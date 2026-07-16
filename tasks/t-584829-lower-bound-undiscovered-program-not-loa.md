---
id: t-584829
title: 'LOWER-BOUND "undiscovered program NOT loaded" note: collapse the repeated multi-line boilerplate to a one-line tag after its first full appearance per session, and surface a usage COUNT for the undiscovered programs (not just a warning)'
status: done
priority: medium
tags:
  - dogfood
type: imp
complexity: M
area: render
source: dogfood-jul
created: '2026-07-15T11:32:31.043Z'
---
The undiscovered-program floor note (`!! LOWER BOUND — N repo tsconfig(s) NOT loaded …`) was re-spelled inline across `find_usages` (usagesFloor), `importers_of` (importersFloor + the subtree fragment), and the sibling hints — pure copy-paste, and verbose.

## Done (stateless consolidation)
The `find_usages` + `importers_of` LOWER-BOUND notes are consolidated onto ONE shared formatter `src/ops/lower-bound-note.ts` (`lowerBoundNote`), built on the `common/truncate` `nameWithMore` primitive (t-188210). Prose tightened (the redundant middle sentence dropped); the machine-readable verdict fields (`complete:false` + `undiscoveredPrograms`) are unchanged, so a count-only consumer is unaffected. The remaining "name K then +N more" copies (definitionFloor, undiscoveredHint, unused-exports, list-inactive-hint, subtree fragment) route through `nameWithMore`.

## (a) session-collapse — REJECTED (do not build)
Collapsing the note to a one-line tag after its first appearance per session needs cross-call session state, and would make a warm daemon's 2nd call differ from a cold-booted daemon's 1st call on the same repo state — a violation of the cold==warm honesty invariant (§16 invariant 3, CI-gated). Documented in `lower-bound-note.ts` so the next reader does not retry it. A BATCH-scoped collapse WOULD be cold==warm-safe (a batch is one atomic read); parked in t-389688 as an option, not built.

## (b) surface a COUNT — SPLIT to t-389688
Actually searching the named programs to resolve the caveat to a complete count is a behavioral change (auto-load siblings, overlaps the `programs:` lever). Out of the render/truncation-foundation scope → t-389688.
