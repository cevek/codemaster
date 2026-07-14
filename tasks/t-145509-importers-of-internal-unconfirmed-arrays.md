---
id: t-145509
title: 'importers_of: internal/unconfirmed arrays capped without {shown,total,hint} (only sibling *Count)'
status: backlog
priority: low
parent: t-188210
tags:
  - dogfood
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-14T16:23:16.150Z'
---
## Finding (class-audit CLASS-B, jul-14 — the ONE genuine result-set non-conformance)
`src/ops/importers-of.ts:149-150` slices the `internal` and `unconfirmed` importer arrays to `limit` (=200), but the canonical `Truncation {shown,total,hint}` envelope points ONLY at the `external` (blocker) set. The internal/unconfirmed shortfall is carried only by sibling `internalCount`/`unconfirmedCount` scalars — no per-array {shown,total}, no recovery hint. A consumer iterating `internal` sees a short list whose truncation is not in the honesty channel.

## Severity / honesty
Low. Not a silent lie in the worst sense — the `*Count` totals ARE present and a comment justifies it (the `safe`/`blockers` verdict is external-only and complete). But it is non-conforming to §3.4 {shown,total,hint} and inconsistent with every other result-set cap in the codebase (all of which ride the canonical channel). Surfaced honestly for consistency.

## Fix
Route the internal/unconfirmed cuts through the umbrella `common/truncate/ capList` (t-188210) so each capped array co-produces its own {shown,total,hint}, OR at minimum add per-array shown/total + a hint. Do NOT weaken the external-only `safe` verdict. Best done as part of the t-188210 chokepoint migration (Family-3).
