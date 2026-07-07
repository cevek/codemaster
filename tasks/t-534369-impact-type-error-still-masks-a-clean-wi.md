---
id: t-534369
title: impact_type_error still masks a CLEAN widen-to-any (explicit `:any` / no intra-file error) — diff-diagnostics can't catch fewer-errors
status: backlog
priority: medium
depends_on:
  - t-993754
tags:
  - dogfood-jul
type: bug
complexity: M
area: impact-usages
created: '2026-07-07T21:30:24.499Z'
---
Residual split off from t-993754 (Case B). t-993754's Level-1 fix flags the masking when the trial edit produces an INTRA-FILE error cascade that collapses the edited symbol's inferred type (`editSiteBroke`/`downstreamTrusted` + loud note). But a CLEAN widen-to-any — e.g. `export const model: any = {…}` with NO intra-file error — is a FUNDAMENTAL limit of the diff-diagnostics approach: widening to `any` produces FEWER downstream errors, so "introduced errors vs baseline" can never catch it; the op still reports `clean:true`, zero notes (purest masking).

Precise detection needs the edited symbol's OVERLAY type (any/unknown vs baseline) — a query the trial-overlay (`gateAcross`) does NOT expose today = a new plugins/ts seam. There's an existing `trace_type_widening` op + ts `wideningSinksAt` primitive that owns "did this widen to any" (forward-flow, current VFS — not overlay); Case B may belong adjacent to it. Out of the edit-disjoint impact-type-error track — needs the ts seam. fix-locus: src/plugins/ts (overlay-type query) + src/ops/impact-type-error.ts.
