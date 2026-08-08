---
id: t-031616
title: 'No union-aware `expand_type` projection: "which variants of this union declare member X" — the question that decides whether a guard can discriminate at all — is answered by hand-reading interface-extends chains'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-228385
  - t-702832
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:02:14.148Z'
---
`expand_type` resolves a type and lists its members. For a UNION it does not answer the question actually
asked of unions: per variant, does this variant declare member X (and what is its type there). The checker
holds all of it; the answer today comes from reading `@types` interface-extends chains by hand.

Why it is review-critical rather than convenient: a set-membership test written against variants that cannot
carry the member is INERT — it looks like a guard and can never fire. Two instances in one session:

- which mdast node types actually have `children` — an entry in a skip-set for a Literal node (`code`,
  `inlineCode`, `html`) is inert, so a test guarding it discriminates nothing;
- which `FieldSpec` variants are collections vs scalars — this drove a real arity defect (`remove_from`
  refused on a single `ref`).

Shape: `expand_type {name, member?: 'children'}` → per variant: declares / does not declare, member type,
proof span at the declaring interface, with the usual honesty when a variant is itself unresolved. One call
each instead of a manual chain walk.

## Свидетельство (field report)

2026-07-31, repo task-manager (web/ package), external agent: «Twice the review-critical question was "which
members of this union carry property X" … Both meant reading @types interface-extends chains manually. A
union-aware expand_type projection ("expand this union's variants, showing which declare X") would have made
each one call.»

**Two inbox entries, one capability.** The same agent filed this twice in the same session (2026-07-30 and
2026-07-31, `task-manager/web-body-task-links`) — once framed as the mdast question, once as the `FieldSpec`
one — and the triage batch briefly carried both as separate tasks. They are merged here: the repetition is
evidence that the question recurs, not a second ask.

What the duplicate carried that is worth keeping: the rest of the surface worked without friction in those
tracks (`find_usages` on freshly created symbols, `source`, the dead-stack verdict), which is what isolates
this as a CAPABILITY gap rather than a usability one.
