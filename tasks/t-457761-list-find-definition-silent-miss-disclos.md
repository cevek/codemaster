---
id: t-457761
title: list/find_definition silent-miss disclosure does NOT fire when a nested package's tsconfig IS discovered (referenced/adjacent) but its framework plugin stays OFF (autodetection gates on ROOT package.json) → available(0) with undiscoveredProgramLabels() empty, no disclosure
status: backlog
priority: low
tags:
  - dogfood
type: bug
complexity: M
area: framework
source: dogfood-jul
created: '2026-07-15T13:04:06.299Z'
---
## Residual from Track C (t-673978 / t-857923)

Track C made `list` (t-857923) and `find_definition` (t-673978) disclose a silent miss when `undiscoveredProgramLabels()` is non-empty — i.e. a nested tsconfig codemaster did NOT load as a program.

**Uncovered case:** a nested package whose tsconfig IS discovered (adjacent to primary, or reached via `references`/`workspaces`) so it loads as a program AND drops OUT of `undiscoveredProgramLabels()` — but whose framework plugin (react/react-query/…) stays OFF because autodetection gates on the ROOT `package.json` (`daemon/framework-plugins.ts`). Then `list {registry:'components'}` at root gives `found=false / available(0)` with `undiscoveredProgramLabels()` EMPTY → the Track-C disclosure does NOT fire, and the bare found=false reads as "no components" again.

**Fix direction:** this is autodetection territory — the react plugin should activate when a react dep is present in ANY loaded program's package.json (not only root), or the disclosure signal should widen beyond `undiscoveredProgramLabels()` to "a loaded program has a framework dep but its plugin is off at this root". See t-000026 (react autodetection). Related: t-857923, t-673978.

**UNVERIFIED** — not hermetically reproduced yet (needs a discovered-but-plugin-off fixture); file first, repro before fixing.
