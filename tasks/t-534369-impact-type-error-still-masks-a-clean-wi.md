---
id: t-534369
title: impact_type_error still masks a CLEAN widen-to-any (explicit `:any` / no intra-file error) — diff-diagnostics can't catch fewer-errors
status: done
priority: medium
depends_on:
  - t-993754
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-07T21:30:24.499Z'
---
DONE — Case B (clean widen-to-any masking) is now HANDLED, not a deferred fundamental limit. impact_type_error flags widenedToAny=true + downstreamTrusted=false + a loud !! lower-bound note when a trial edit widens the edited symbol's own inferred type to `any` (explicit :any, inferred any, or a function-return any) with no intra-file error — the diff-of-diagnostics can't see the fewer-errors masking, so honesty comes from the new verdict FLAG. New ts seam overlaySymbolType (overlay-type.ts) reads the edited symbol's type under the trial overlay vs baseline as a pure fact (collapse via independent TypeFlags.Any per program-version state — no invalid cross-checker relation); the op owns the verdict. `unknown` correctly NOT flagged (self-revealing → diff catches it). Residuals: sibling-resident probe reachability + deep-member collapse (filed separately).
