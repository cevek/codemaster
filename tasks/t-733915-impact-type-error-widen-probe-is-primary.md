---
id: t-733915
title: 'impact_type_error widen probe is primary-only: when findDefinition is extended to resolve sibling-only decls, a sibling-resident widened symbol will silently no-flag while downstreamTrusted reads true'
status: backlog
priority: medium
depends_on:
  - t-773499
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-08T11:43:18.375Z'
---
**RECLASSIFIED (2026-07-16): NOT reproducible on current main — a COUPLING-REQUIREMENT on the non-primary findDefinition extension, not a standalone bug.**

Verified non-repro (hermetic, main b308ec8): impact_type_error resolves its target via `findDefinition` (`ops/impact-type-error.ts:183`) and fails at `:184` BEFORE the widen-probe, because `findDefinitions` (`plugins/ts/definitions.ts:16`) is **primary-service-only** (`host.service.getDefinitionAtPosition` — does NOT fan across programs like find_usages). So a sibling/isolated-package target FAILs honestly ("Could not find source file"); the silent no-flag + `downstreamTrusted=true` the original task feared is NOT reachable while findDefinition stays primary-only. The honest FAIL IS the safety.

**The coupling (why this stays open, blocked on t-773499):** the moment findDefinition is extended to resolve non-primary decls (exactly what **t-773499** does — make find_definition/rename work on member/isolated-package programs), impact_type_error's target-resolve at :183 will SUCCEED for a non-primary target, then run its **primary-only widen-probe overlay** → a non-primary widened symbol silently no-flags while `downstreamTrusted` reads true (§3.6 silent-miss). Coupling already noted in `overlay-type.ts:88-93` (`readTopLevelType`).

**Requirement (owned by whoever lands t-773499):** in the SAME change that fans findDefinition across programs, impact_type_error must either (a) fan its overlay/widen-probe into the target's OWNING program, or (b) emit `downstreamTrusted=false` + a foreign-program disclosure for a non-primary target — never a silent no-flag at trusted=true. Discriminating test becomes reachable only after (a)/(b) exists.

Source: track M investigation 2026-07-16 (non-repro + locus). Coupled to t-773499 (track K).
