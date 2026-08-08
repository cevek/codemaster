---
id: t-575194
title: find_usages' props filter answers "which call site passes prop P (with which value)" and three agents in one week did not find it — two fell back to grep, one to inferring the prop name from declared-vs-passed counts
status: backlog
priority: high
tags:
  - agent-surface
  - discoverability
  - dogfood
  - react
type: dx
complexity: M
area: framework
source: dogfood-inbox-aug
relates:
  - t-089408
  - t-109741
  - t-826059
audience: external
evidence: reported
created: '2026-08-08T12:01:13.894Z'
---
`find_usages {name:'X', props:{P: true|value|values[]}}` resolves the component through the LS and reports,
per JSX call site, whether P is passed and with WHAT value — literals normalized, a non-literal rendered as
`P={expr}`, `excludedByProps` counting the sites the filter dropped, `propsUncertain {dynamicValue,
spreadMaybe}` carrying the honesty. That surface answers every prop-at-call-site question below, and is not
reached at the moment of need.

The shape of the failure is uniform across the reports: the agent enumerates the op LIST, sees `find_usages`
described as "reference sites of symbol(s)", concludes that no op distinguishes `readOnly={readOnly}` from
`readOnly={false}`, and leaves. The capability is one nested arg deep inside an op whose one-line summary
never mentions props; the per-op notes that DO describe it are read only after an agent already decided the
op is relevant.

What to change is a salience question, not a capability one — candidates the picker should weigh: naming the
prop-audit capability in `find_usages`' one-line summary (the string every op-list render carries), a
`concepts:` entry for the prop-at-call-site question in the same shape as `absence-audit`, and steering from
the ops that are reached INSTEAD (`find_unused_props`, whose declared-vs-passed counters are what two agents
used as a substitute).

Residual capability gaps genuinely NOT covered by the props filter, tracked separately: a declared prop that
the component accepts and never forwards to a DOM element, and the dual direction of `find_unused_props`.

## Свидетельство

Three independent external reports, three amiro worktrees, all after the filter shipped (2026-07-28):

- **2026-08-03, `qa-encounter-editor`** — the day's real defect: `ClinicalEntryPanel.tsx:362` passed the
  literal `readOnly={false}` to `ClinicalEntryEditor`, so a write-permission gate arrived as a constant past
  every predicate; neighbouring controls gated correctly, so no symbolic path led from symptom to root. Asked
  for an op `literal_props {component, prop, valueKind:'literal'}`; answered by reading the file by eye.
  `find_usages {name:'ClinicalEntryEditor', props:{readOnly:false}}` is that query.
- **2026-08-05, `forms-w2-booking`** — auditing which controls do NOT forward `aria-describedby`; recorded
  "no op for it" and instead read `find_unused_props`' arithmetic (`declared=3, passed=4`) and INFERRED the
  extra prop's name. Reported as "an inference from a count, not an answer".
- **2026-08-05, `qa2-settlement-panel`** — grepped for `forceMount`, then filed a CORRECTION on its own
  entry: "That op already exists and I simply did not reach for it. `find_usages {name:'SheetContent',
  props:{forceMount:true}}` … answers it better than the grep I used: usages=0, excludedByProps=40,
  propsUncertain: dynamicValue=0 spreadMaybe=0 — a NEGATIVE result with proven completeness over all forty
  JSX call sites."
