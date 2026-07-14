---
id: t-487095
title: Consolidate the 4 `elide(s, cap)` copies + add §3.4 recovery hints to the 3 twins
status: backlog
priority: medium
tags:
  - copy-paste
  - dogfood
  - ts-core
type: imp
complexity: S
area: ts-core
source: dogfood-jul
created: '2026-07-14T16:10:34.434Z'
---
## Context
t-481241 fixed `expand_type`'s per-string elision (verbosity-aware cap + §3.4 recovery marker with full length) in `src/plugins/ts/type-expand.ts` via a shared local `elide(s, cap, kind)` helper. That fix DELIBERATELY stayed in the owner file (variant B, manager-approved) to keep blast-radius tight.

## The residual (class, not instance)
The same `s.length > CAP ? \`${s.slice(0,CAP)}… (type elided)\` : s` idiom is copy-pasted across **4 sites**, now with TWO diverging marker formats:
- `src/plugins/ts/type-expand.ts` — RICH marker (`… (type|signature elided: N chars — verbosity:full[, or expand_type the param type])`), verbosity-aware cap. [fixed by t-481241]
- `src/plugins/ts/first-param-members.ts:167` — bare `… (type elided)`, fixed 200 cap.
- `src/plugins/ts/overlay-type.ts:169` — bare `… (type elided)`, fixed `TYPE_CAP`.
- `src/plugins/ts/type-widening.ts:274` — bare `… (type elided)`, fixed `TYPE_CAP`.

## EXCLUDE from consolidation (thin-difference trap — copy-paste-reviewer, t-481241)
`src/plugins/ts/member-usages.ts:220 typeNameOf` uses the SAME `typeToString(NoTruncation)`+slice shape BUT a materially different contract: cap `TYPE_NAME_CAP = 120` (not 200), bare `…` with NO `(type elided)` marker — it is a short type-*name* hint, not a full-type render. Do NOT fold it into the shared `elide`: widening its cap or adding an "elided/recover" marker to a deliberately-short name would be wrong. The 4 sites above are the exact scope; member-usages is a deliberately-different 5th cousin.

## Work
1. Extract ONE shared `elide(s, cap, kind)` helper (candidate home: `plugins/ts/type-elide.ts`) and route the 4 sites through it → kills the duplication (copy-paste class) and unifies the marker (report full length, never a silent `…`, §3.4).
2. Add the §3.4 recovery hint to the 3 twins' markers. NOTE: their owning ops (`find_unused_props` via first-param, `impact_type_error` via overlay, `trace_type_widening`) do NOT thread `verbosity:full`, so "verbosity:full" is NOT a valid recovery for them — the twin hint should report only the full length (+ "expand_type the symbol" where meaningful), not "verbosity:full". Decide per-site whether verbosity-threading is worth adding to those ops (probably not).

## DoD
Single elide helper, the 4 in-scope callers use it (member-usages EXCLUDED), marker consistent + carries full length; oracle-backed test for at least one twin's marker; fix-and-check green; no file >300 lines.
