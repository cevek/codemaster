---
id: t-262394
title: 'expand_type signatures: prefer named-ref param type over structural inline (matching `about`)'
status: backlog
priority: low
tags:
  - dogfood
  - ts-core
type: imp
complexity: M
area: ts-core
source: dogfood-jul
created: '2026-07-14T16:10:40.338Z'
---
## Context
Third shortfall from t-481241 (deferred there as a checker-behavior seam). For a handler whose param is a NAMED generated type (amiro `createAuthzAccessRequest`, param `I.CreateAuthzAccessRequestInput`):
- `expand_type` `about` shows the CLEAN named ref: `(input: I.CreateAuthzAccessRequestInput, ctx: HandlerCtx) => Promise<...>`.
- `signatures[]` STRUCTURALLY INLINES the param type: `(input: { data: { resourceType?: "PATIENT"... }, ... }, ...)` — 271 chars, blows the default cap and elides.

So the `signatures` form is strictly LESS useful than the `about` head for a named-param handler.

## Hypothesis (starting seam)
`about` comes from `getQuickInfoAtPosition` displayParts — the checker's node-based writer, which preserves the WRITTEN annotation / alias name. `signatureToString(sig, undefined, NoTruncation)` resolves the param type structurally. Candidate flag: `ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope` — may make the param render as the alias name. RISK: changes rendering across ALL signatures repo-wide (regression surface) — needs an oracle-backed sweep, not a blind flip. Verify t-481241's fix (verbosity:full + recovery hint) already gives the escape hatch, so this is a density/quality enhancement, not a correctness bug.

## DoD
Decide + implement (named-ref preferred, or point signatures at the param type when it would elide); oracle-backed test (cold ts.Program) proving named params render by name and structural anonymous params still expand; no regression to the existing expand-type differential suite.
