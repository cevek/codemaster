---
id: t-736832
title: No op answers whether a type's FIELD reaches a request body — trace_field_to_render goes the opposite way, and "it reaches nothing" is the answer that cannot be obtained
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - trace
type: feat
complexity: L
area: trace
source: dogfood-inbox-aug
relates:
  - t-242062
  - t-904217
audience: external
evidence: reported
created: '2026-08-08T12:05:27.250Z'
---
## What is missing

Given a field on a draft / form type: does its value reach ANY outbound API call? No op answers it.

- `trace_field_to_render` traces a field to the components that RENDER it — the opposite direction.
- `member_usages` returns every `x.field` site but not whether any of them flows into an `api.X({data})`
  argument. On a field nobody reads yet it correctly returns nothing, which proves only that nothing reads it
  TODAY — not that a payload builder cannot pick it up through a spread.
- `find_usages` on the TYPE is worse: the draft type is passed around wholesale.

Shape: `trace_field_to_request` (or `direction:'outbound'` on `trace_field_to_render`) — from a type's field,
follow assignments / spreads / property reads to the argument of any call reaching the generated API surface,
reporting each hop and flagging the SPREAD hops as the point where the answer stops being structural. Both
answers are valuable and opposite: "reaches `api.updateEmployee` via `patch.access` at file:line", and
"reaches nothing — and no spread of its parent occurs anywhere on the path". The second is the one that
cannot be obtained today.

## Свидетельство

2026-08-05, `amiro/forms-authz-destructive`. Hit twice in one track, worked around by hand both times. A
field `coveredClinics` was added to the shared draft type `AccessFormFields`
(`src/features/team/access-model.ts`) as editor memory that must NEVER be sent, and the agent had to prove it
cannot reach the wire. What it took: reading both payload builders (`buildSavePlan` in
`TeamMemberDetailPanel/save-plan.ts` and `useAddEmployeeSubmit`) and confirming BY EYE that each assembles
its body key by key rather than spreading the draft. That reading IS the whole proof, and it silently expires
the day someone writes `data: {...draft}`.

Why it recurs in that repo rather than being a one-off: the central form rule is "buffer drafts until Save",
whose stated failure mode is a predicate asking the DRAFT while the request carries something else. A sibling
track hit the same seam from the other side — an address editor keeps a value the payload builder reads in
one mode only, so the refusal predicate saw an address where the request sent an empty block: green toast,
address erased.
