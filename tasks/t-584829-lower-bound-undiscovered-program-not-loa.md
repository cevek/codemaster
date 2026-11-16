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

## (a) session-collapse — in the MCP facade, not in the op
The op's `Result` carries the whole note on every call, so cold == warm (§16 inv. 3) holds. The explanation after the `!!` facts is a lesson per noun variant (`LOWER_BOUND_LESSONS`); the MCP facade folds its repeats within one client session to `short [id]` (§12 session prose folding, t-720126). `status {concept:"<id>"}` expands it.

## (b) surface a COUNT — SPLIT to t-389688
Actually searching the named programs to resolve the caveat to a complete count is a behavioral change (auto-load siblings, overlaps the `programs:` lever). Out of the render/truncation-foundation scope → t-389688.
