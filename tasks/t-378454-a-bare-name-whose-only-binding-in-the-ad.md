---
id: t-378454
title: A bare name whose only binding in the addressed file is a TYPE resolves to the value side and answers a plausible 0 sites with a note that misdescribes the target
status: backlog
priority: high
tags:
  - dogfood
  - dogfood-aug
  - honesty
type: bug
complexity: M
area: ts-core
source: dogfood-inbox-aug
relates:
  - t-259465
  - t-335208
surface:
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:02:24.438Z'
---
A bare `{name}` that is bound in the addressed file ONLY as a type — `import type {PatchTaskInput} from …` —
resolves to the VALUE meaning of the name. `construction_sites` then reports the resolved value as a
top/open type and answers `0 sites` with a note telling the caller to "pass a type name".

Three separate failures compound:

1. **The answer is a plausible zero.** `0 sites` for "what builds this payload type" reads as "nothing builds
   it" — a proven absence the tool never established. Nothing in the shape distinguishes it from a real 0.
2. **The note misdescribes the target.** It says the name resolved to a value; the caller can see in their own
   source that it is a type-only import, so the tool contradicts what the agent can verify — the §3 failure
   the trust contract exists to prevent.
3. **The remedy is inert** (§ CONTRIBUTING refusal doctrine, epic `t-259465`): "pick a concrete type" cannot
   change the outcome, because the target ALREADY WAS a concrete type. A lever that cannot move the result is
   the cardinal case that doctrine names.

## What correct looks like

A bare name with a TYPE binding and no value binding in the addressed scope resolves to the type. Where both
meanings exist and the op is type-anchored (`construction_sites`, `discrimination_sites`, `expand_type`), the
type meaning is the one the op can act on; if the resolver genuinely cannot choose, that is a FAILED
resolution and must return as a failure, never as an `ok` shaped like a proven absence.

## Свидетельство (field report, 2026-08-05, /Users/cody/Dev/worktrees/amiro/forms-clear-policy)

`construction_sites {name:'PatchTaskInput'}` → `0 sites`; notes: the name resolved to a VALUE, not a type
("pass a type name"), then that the value is a top/open type. `PatchTaskInput` is imported as
`import type {PatchTaskInput}` at
`src/features/tasks/TasksView/useTasksWorkspaceMutations.ts:11`. External agent, repo it does not maintain.

Filed by the same reporter as `t-335208` as a "secondary, smaller" item; it is separated here because it is a
different mechanism — resolution, not scoping — and because a wrong resolution answering `ok{0}` outranks a
missing capability.

UNVERIFIED on current `main`: not reproduced hermetically, taken from the field report.
