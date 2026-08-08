---
id: t-029335
title: member_usages answers "type 'X' has no member 'Y'" when X is not a type at all — a FAIL about a FUNCTION asserts a fact about a type that does not exist, and reads as "the member is gone"
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
  - honesty
type: bug
complexity: S
area: correctness
source: dogfood-inbox-aug
relates:
  - t-318026
  - t-340801
  - t-934520
audience: external
evidence: reported
created: '2026-08-08T12:03:42.711Z'
---
`member_usages` emits ONE sentence for two different situations: "the named type exists and has no such
member" and "the name does not denote a type at all" (a function, a const, a component). For the second the
message `type 'useClinicalEntryActions' has no member 'commitDirtyInKind'` is a false statement about the
nature of the symbol, and the conclusion it hands an agent — the member is gone — is wrong about a symbol
that exists and a member that exists on its inferred return.

The op must say which state it reached: a target that resolves to a VALUE (function / const / component)
rather than a type is a resolution outcome the op established, and stating it redirects the caller in one
call instead of two. Same family as t-934520 (an index-signature type answered with a "has no member"
absence the analysis does not support) and t-340801 (a FAIL that reads like a typo diagnosis) — one
message doing the work of several distinct verdicts.

## Свидетельство

2026-08-05, external agent, amiro worktree `forms-w2-chains`.
`member_usages {name:'useClinicalEntryActions', member:'commitDirtyInKind'}` → `FAIL type has no member`.
The hook exists and returns that property; it simply declares no return interface. Reporter: "reads as 'the
member is gone', which is a wrong conclusion to hand an agent about a symbol that exists … saying so would
have redirected me in one call instead of two." The capability side of the same report is t-318026.
