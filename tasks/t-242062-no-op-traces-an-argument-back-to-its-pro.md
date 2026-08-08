---
id: t-242062
title: No op traces an argument back to its PRODUCER — "what actually arrives in this parameter, who built it, and do all call sites build it the same way" is one step past find_usages and gates the riskiest edits
status: backlog
priority: high
parent: t-560034
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-288409
  - t-479658
audience: external
evidence: reported
created: '2026-08-08T12:02:28.565Z'
---
## What is missing

`find_usages` gives the call SITES; the sibling task t-479658 gives the argument EXPRESSION and its literal
value at each site. Neither answers the next step: when the expression is a variable, **where was that
value built**, and **do all call sites build it from the same origin**.

Two verdicts off one mechanism (resolve the producer of the expression standing in parameter N):

1. **Producers.** Per call site: `{expression, kind (literal | variable | call | spread), defined-at}` —
   plus an explicit `dynamic` wherever the walk cannot see the producer (a runtime registry, a spread, an
   `as` cast). The `dynamic` marking is worth more than completeness here: it NAMES the surface that has to
   be reasoned about separately, which today only a reviewer's memory does.
2. **Origin singularity.** Group the sites by originating symbol and flag `origins > 1`. "One call site
   takes `SCHEMA_HASH`, another `STORE_HASH`" is then visible in one call, and the checkable invariant
   "this constant must be the ONLY source for parameter N of F" becomes expressible ("who passes something
   else here").

`construction_sites` does not substitute: it starts from the TYPE, and the question is asked from the
POSITION — precisely because the asker doubts that the actual values match the declared type (a cast at a
mock boundary, or an untyped runtime path, hides the mismatch the type claims cannot happen).

## Свидетельство

**2026-08-03, `amiro/local-api-shape`** — gating the riskiest edit of the track. The read semantics of a
parameter changed: previously the function distinguished a bare value from a `{value}` wrapper by
`typeof x === 'object' && 'value' in x`; now the input is always a wrapper and `x.value` is read. A bare
value reaching the new code reads as "clear this field" — **silent data deletion, no error, no type
signal**. Typecheck did not protect: the generated type forbids a bare value, but a cast at the mock
boundary hid exactly that, and part of the calls go through a runtime handler substitution
(`overrideHandler`) where there is no type at all. To prove "no producer sends a bare value" the agent ran
`find_usages` on the mutation hook, then read every call site by eye for the body literal, checked both
fields were wrapped in a `nullableField` helper, and separately had to REMEMBER `overrideHandler`, seed and
dev-recorder as untyped producer surfaces: three searches plus one "did I forget a surface".

**2026-08-03, `amiro/local-api-foundation`** — the origin-singularity half. A persistent store is keyed by a
value computed in one place that must reach ALL calls (`localStore.bootstrap(key,…)` and
`localStore.reset(key,…)`). The feared defect, later confirmed by a reviewer as a real class: two call sites
compute the key DIFFERENTLY, so `reset` writes a snapshot the next boot rejects — a wipe on every reload.
Completely silent: both are strings, types agree, tests green, the app boots. A third call site lived in
`docs/local-api/extending.md` and had already diverged (it used the bare `SCHEMA_HASH`). The reporter notes
explicitly that the literal-value view (t-479658) would NOT have caught it: both sites read `STORE_HASH`
today, and the question is whether anyone passes an origin of their own.

Requested surface names from the field: `value_sources {name, param}` and
`argument_sources {name, param}` → `file:line:col | expression | origin symbol`, flagged when origins > 1.
