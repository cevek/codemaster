---
id: t-318026
title: member_usages needs a NAMED type, so a hook whose object return is INFERRED has no member-level answer — "does any consumer destructure this returned property" is left to hand-reasoning over find_usages output
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - react
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-340801
  - t-757342
audience: external
evidence: reported
created: '2026-08-08T12:03:26.731Z'
---
"This hook returns `{a, b, c}` — does anything outside the file actually take `b`?" is the React shape of
dead-code hunting, and no op answers it when the return type is INFERRED:

- `find_unused_exports` does not apply — the property is not an export, the hook is;
- `member_usages` is the right op but addresses a NAMED type: it answers for
  `{name:'UseAppointmentMutationsResult', member:'performEditChain'}` and cannot for
  `{name:'useClinicalEntryActions', member:'commitDirtyInKind'}`, because that hook declares no return
  interface — the common shape in a real React codebase;
- `find_usages {name:'commitDirtyInKind', groupBy:'enclosing'}` answers a NEARBY question. It lists refs and
  their enclosers, from which a human can CONCLUDE nothing external destructures the property — but the
  reasoning is the reader's, not the tool's, and identical output would appear for a property destructured
  elsewhere under a rename or through a spread.

Either of two shapes closes it: let `member_usages` take a FUNCTION whose return is an object literal
(resolve the return type through the checker, then answer as usual), or add a `returned_members` answer
classifying each returned property as destructured / member-accessed / never taken.

Distinct from the sibling gap on the same surface: a generated / library-declared NAMED type that cannot be
anchored at all (t-340801) is an ADDRESSING problem on a type that exists; this is the absence of a type to
address. Same for the component-body direction (t-757342): that one scopes reads to one component body, this
one resolves an anonymous return shape.

## Свидетельство

2026-08-05, external agent, amiro worktree `forms-w2-chains`; the question came up twice in one track.
`member_usages {name:'UseAppointmentMutationsResult', member:'performEditChain'}` worked;
`member_usages {name:'useClinicalEntryActions', member:'commitDirtyInKind'}` could not be asked. Fallback:
`find_usages {name:'commitDirtyInKind', groupBy:'enclosing'}` → 4 refs, all enclosed by the declaring
function, from which the agent concluded by hand that no consumer destructures it. Reporter: "most hooks in
this repo are that shape."
