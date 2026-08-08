---
id: t-743744
title: 'find_unused_props computes the passed-but-undeclared set and prints it as two bare numbers: `notDeclared` names appear only when the caller already guesses the prop, so found=0 reads as clean over a live defect'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - honesty
  - react
type: imp
complexity: S
area: framework
source: dogfood-inbox-aug
relates:
  - t-575194
audience: external
evidence: repro
created: '2026-08-08T12:02:17.214Z'
---
The default call (`find_unused_props {component}`) reports `declared=N`, `passed=M` and, when nothing is
declared-and-unpassed, `found=0` — which reads as "clean". A `passed &gt; declared` mismatch is the whole
defect signal and is delivered as arithmetic the reader must notice and then interpret. The names are
withheld: `notDeclared` is populated only on the `prop:`-addressed branch
(`plugins/react/unused-props.ts` `answerRequested`), i.e. only for a caller who already knows the name to
ask about — which inverts the point of asking.

Change: whenever `passed &gt; declared`, list the undeclared prop names in the default output, in the same
`notDeclared` field. The data is already computed on both sides of the comparison. That turns "a number I
must notice" into "a name I must answer", and makes the op able to FIND a defect class it can today only
confirm.

Why by default and not on request: this class is invisible to tsc by construction (a hyphenated JSX
attribute is not checked against the props type), so no other gate in the repo catches it; and the props most
often affected are the `aria-*` ones, where the failure is silent for a sighted developer and total for
everyone else.

Note the existing honesty branch must be preserved: under a CAPPED declared-member set a passed-but-absent
name is `undetermined`, never `notDeclared` (a proven absence over an unseen set). The default-output
version inherits that split unchanged.

## Свидетельство

2026-08-05, external agent, amiro worktree `forms-w2-a11y`. A call site passed `aria-describedby` to
`PatientTypeahead`, which does not declare it; React dropped it silently, TypeScript never objected, and the
result was a form field whose error message existed in the DOM and reached no assistive technology.
`find_unused_props {component:'PatientTypeahead'}` → `found=0, declared=3, passed=4`;
`find_unused_props {component:'PatientTypeahead', prop:'aria-describedby'}` → `notDeclared:
['aria-describedby']`. Reporter: "the data is there and the op can say it — it just requires knowing the name
in advance".

Verified on current `main` (2026-08-08): the no-`prop` branch of `buildUnusedPropsView` builds only `unused`
and never populates `notDeclared`.
