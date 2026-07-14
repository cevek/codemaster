---
id: t-481241
title: 'expand_type: signature elision not verbosity-aware + no recovery hint (MEMBER_TYPE_CAP fixed 200)'
status: backlog
priority: medium
tags:
  - dogfood
type: bug
complexity: S
area: ts-core
source: dogfood-jul
created: '2026-07-14T15:12:16.083Z'
---
## Repro (current main, live on a sibling repo)
`expand_type { name: 'createAuthzAccessRequest', root: '/Users/cody/Dev/amiro', verbosity: 'full' }` →
```
signatures (1): (input: { data: { resourceType?: "PATIENT" | undefined; … (signature elided)
```
`verbosity: full` does NOT lift the elision — confirmed live.

## Root
`src/plugins/ts/type-expand.ts:158 signatureStr` applies a FIXED module constant `MEMBER_TYPE_CAP = 200` (line 14) after `signatureToString(NoTruncation)`. The marker `… (signature elided)` is intentional & correct (replaces TS's silent `...` per §3.4). Three shortfalls vs the project's OWN contracts:

1. **Not verbosity-aware.** The cap is a constant, not threaded from `verbosity`. `full` uncaps `memberLimit` (advertised) but NOT the signature — a user asking for "everything verbatim" has no escape.
2. **No recovery hint (§3.4).** Sibling members-truncation writes `… (raise memberLimit)`; this marker carries neither `total` length nor any hint (e.g. "expand_type the param type" / "verbosity:full"). §3.4 truncation = {shown, total, hint}.
3. **Elided form < `about`.** `about` already shows the clean NAMED-ref signature (`input: I.CreateAuthzAccessRequestInput, …`); `signatures` STRUCTURALLY INLINES the param type → blows the budget → truncates → yields less than `about`.

## Fix direction (any subset)
(a) thread `verbosity` into `signatureStr` so `full` raises/removes the cap; (b) add a recovery hint + report full length on the marker; (c) when a signature would elide, prefer the named-ref rendering (as `about` does) over structural inlining, or point at `expand_type` of the param type.

Note: the twin `typeStr` cap (line 300, `… (type elided)`) likely has the same verbosity/hint gap — check both. Global feedback filed to ~/.codemaster/feedback/inbox.md.
