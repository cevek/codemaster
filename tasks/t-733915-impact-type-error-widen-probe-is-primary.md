---
id: t-733915
title: 'impact_type_error widen probe is primary-only: when findDefinition is extended to resolve sibling-only decls, a sibling-resident widened symbol will silently no-flag while downstreamTrusted reads true'
status: backlog
priority: medium
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-08T11:43:18.375Z'
---
From t-534369 (Case B). The overlaySymbolType widen probe reads the edited symbol under a PRIMARY-only overlay. Today this is UNREACHABLE via impact_type_error: a sibling-only decl FAILs honestly at findDefinition ('Could not find source file') BEFORE the probe runs (an honest FAIL, not a lie). BUT search_symbol ALREADY resolves sibling-only decls — so WHEN findDefinition is extended to do the same, the widen probe becomes reachable for a sibling-resident target and will silently no-flag (overlay is primary-only) while downstreamTrusted reads true = a masking lie. COUPLED: whoever lands sibling-decl resolution in findDefinition MUST fan the overlay to the owning program OR emit a foreign-disclosure at that point. fix-locus: src/plugins/ts/overlay-type.ts (readTopLevelType primary-only guard) + src/ops/impact-type-error.ts.
