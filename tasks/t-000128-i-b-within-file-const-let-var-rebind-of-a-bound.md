---
id: t-000128
title: I-b — within-file `const`/`let`/`var` REBIND of a bound name fabricates a missing row
status: backlog
priority: low
type: bug
complexity: M
area: i18n
relates:
  - t-000127
surface:
  - plugins/i18n
  - plugins/ts
audience: external
evidence: repro
created: '2026-07-08T00:02:07.000Z'
---
**I-b — within-file `const`/`let`/`var` REBIND of a bound name fabricates a missing row** —
param + catch-var shadowing is CLOSED (the by-identity scan gates the match through
`scope-shadow.ts` `extendShadow`). What remains: a `const`/`let`/`var` rebind of `t`
(`const t = (k) => k; t('absent.key')`) is NOT gated — `extendShadow` only introduces shadows
for params/catch vars, since a sound rebind skip needs block-POSITION-aware shadowing. The two
directions differ: `find_unused` UNDER-reports (counts the rebound call → false "used", safe),
but `find_missing` FABRICATES — a certain missing row with a proof-span on the local closure
for a key that is not an i18n usage. The same hole exists in the BY-NAME scan
(`scanByName`, `src/plugins/ts/literal-calls.ts`), which matches any same-named `t` with no
scope check at all (no binding pool to anchor `extendShadow` against). Rare.
`bug`·`fabrication`·`low`·`cx:M`

**Related:** t-000127 (scss `scanCssModuleUsages`) states the identical defect and the identical fix — a `const`/`let`/`var` rebind is not treated as a shadow, and a sound skip needs block-POSITION-aware shadowing. One mechanism, two plugins; the shadowing primitive is the shared work.
