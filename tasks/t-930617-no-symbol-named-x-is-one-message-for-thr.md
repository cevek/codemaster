---
id: t-930617
title: '"no symbol named X" is one message for three different facts — deleted, misspelled, or living in a program we did not load — so a deletion audit reads a typo as a clean bill of health'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
  - honesty
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-259465
  - t-561552
  - t-647309
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:05:13.784Z'
---
A name that resolves to nothing answers `no symbol named 'X'`. That sentence is literally true and covers
three states with different next moves:

- **the symbol is gone and nothing references it** — the success a deletion audit is looking for;
- **the name was misspelled** — the caller's error, and the one that silently reads as success;
- **the symbol lives behind a program / tsconfig codemaster did not load** — our floor, not their answer.

The failure is asymmetric and in the unsafe direction for exactly the task this shape arises in: after a
codegen re-run or an API migration, "prove these N operations have zero call sites" is answered identically
whether the audit passed or the agent fat-fingered a name. A typo reads as a clean bill of health.

This is `t-647309`'s invariant (emptiness must carry HOW it was established) applied to the RESOLVE side,
which that epic's member set does not reach — its five members are all scope/walk cases where a producer
scanned something. Here nothing was scanned at all, because resolution failed first.

## Ask (cheap, and the reporter's own)

When a name resolves to nothing, say whether it occurs as TEXT anywhere in the file set codemaster already has
open:

- `no symbol named X, and no textual occurrence in N loaded files` → the deletion audit's answer;
- `no symbol named X, but 3 textual occurrences in …` → a typo, an unloaded program, or a string literal, and
  it points at which.

Same call, one extra line, no new index — the loaded file set is already in memory. Where the loaded set is
itself a floor (undiscovered programs), the count must be stated as a floor, per §3.4.

Note the neighbouring constraint from `t-561552`: any message about "what can find this symbol" must be scoped
per declaration FORM, since the workspace name search finds `import * as X` and a top-level binding pattern
while missing `export * as ns` and an object-literal property. A textual-occurrence line sidesteps that trap —
it claims only what it measured.

## Свидетельство (field report, 2026-08-07, /Users/cody/Dev/worktrees/amiro/sync-w0-api-foundation)

External agent. Task: prove three backend operations removed from an OpenAPI spec (`addClinicEmployee`,
`removeClinicEmployee`, `listEmployeeClinics`) have zero remaining call sites after a migration.

`find_usages {symbols:[…]}` returned, for all five names passed:

    unresolved (5):
      addClinicEmployee · no symbol named 'addClinicEmployee'

Two of the five (`createClinicEmployee`, `deleteClinicEmployee`) were mock-handler names that EXISTED in the
repo minutes earlier and had just been removed by the agent's own edit. So one output covered both "you asked
about something that never existed" and "you asked about something you just deleted", with nothing to tell
them apart.

Workaround: the agent fell back to the compiler as the deletion oracle and used `find_usages` only as a
search. Reporter: "it means the op cannot be used for the audit at all — not that it should be trusted less."
