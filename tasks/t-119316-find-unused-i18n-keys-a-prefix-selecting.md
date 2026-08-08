---
id: t-119316
title: 'find_unused_i18n_keys: a prefix selecting ZERO keys answers "unused (0)" with degraded=false — an empty scan laundered into a confident proof of absence'
status: backlog
priority: high
tags:
  - dogfood
  - honesty
  - i18n
type: bug
complexity: S
area: i18n
source: dogfood-inbox-aug
relates:
  - t-381761
  - t-919920
  - t-949045
surface:
  - ops
  - plugins/i18n
audience: external
evidence: repro
created: '2026-08-08T12:00:29.203Z'
---
Two defects that compound into the exact failure the tool exists to prevent — a proof of absence that is
green because the detector examined nothing.

**1. `keys=0` is not surfaced as a problem.** A `prefix` that selects an EMPTY key set produces
`scanned: keys=0 usages=2341` + `unused (0)`, which reads as an authoritative "nothing under this prefix
is dead". Nothing states that the floor is zero. This is the i18n instance of the shared empty-scan
doctrine (`ops/scan-coverage.ts`, `!! NOT A VERDICT` / `EMPTY_SCAN_DOCTRINE`, cf. t-919920 / t-381761):
an empty SCAN and an empty RESULT are different facts and must not render alike. The refusal should name
the cause's own lever — here, the prefix that matched nothing ("prefix matched 0 keys — did you mean
'patients'?").

**2. `degraded` goes FALSE when the key set is empty, while `globalDemote=true` still prints.** The
honesty flag is computed against the SELECTED keys, so selecting none launders a globally-undecidable
question into a confident negative. A degradation that a narrower query cannot lift (the op's own hint
says as much) must survive narrowing to zero. `degraded=false` beside `globalDemote=true` is a
self-contradicting envelope and should be unrepresentable.

## Свидетельство (2026-08-07, `amiro/sync-w1c-patients-multiclinic`)

After restructuring the `patients.clinics` locale subtree (a string key became an object namespace), the
reporter asked with the prefix as it appears in `t()` calls — with the trailing dot:

```
find_unused_i18n_keys {prefix: 'patients.'}
→ degraded=false  globalDemote=true
  scanned: keys=0 usages=2341
  unused (0):
```

The same call WITHOUT the dot is honest:

```
find_unused_i18n_keys {prefix: 'patients', partials: 'summary'}
→ degraded=true
  degradedReason=cannot prove any key dead — a dynamic t() call with no static prefix exists
  scanned: keys=84 usages=2341
```

The defect was caught only because the second call disagreed with the first.

## Confirmed in current `main` (source-level)

`src/plugins/i18n/verdict.ts` computes `const degraded = anyPartial || hiddenCauses.length > 0`, where
`anyPartial = unused.some((u) => u.confidence === 'partial')` — over the REPORTED rows. With a prefix
selecting zero keys, `unused` is empty, so `anyPartial` is false and `degraded` is false, while
`globalDemote` is a separate whole-scan fact that still prints. That is the laundering path: the scoping
introduced for t-949045 is correct for a populated set and has no floor for an empty one. The empty-scan
half is upstream, at the `plugin.ts:239-247` prefix filter, which yields `keys=0` with no refusal.
