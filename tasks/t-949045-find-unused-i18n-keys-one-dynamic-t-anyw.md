---
id: t-949045
title: 'find_unused_i18n_keys: ONE dynamic t() anywhere demotes every key globally, so `prefix=` narrowing changes nothing — and the hint recommends the exact remedy the caller already applied'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T16:09:51.592Z'
---
TWO independent reports, same day, two different amiro worktrees (`save-only-nav-guard-foundation`,
`save-only-lab-panel-draft`) — external agents doing product work.

```
find_unused_i18n_keys {prefix:'patient.record.patientDetails'}
→ degraded=true globalDemote=true
  degradedReason="cannot prove any key dead — a dynamic t() call with no static prefix exists"
  unused (0)
  hint="cannot prove these dead — partials:\"list\" to see them, or narrow with prefix=<namespace>"
```

Two defects, the second worse than the first:

**1. A SCOPED question is decided by an UNSCOPED fact.** One dynamic `t()` anywhere in the repo demotes
every key globally, so narrowing to a namespace cannot change the verdict. The demote is honest in
principle — a dynamic call might resolve to any key — but it is applied at repo scope to a question asked
at namespace scope. Where the dynamic call's own enclosing namespace is known (or where it provably cannot
produce keys under the queried prefix), the demote should not reach the queried set.

**2. The hint recommends the remedy the caller ALREADY applied.** Both reporters called with `prefix=` and
were told to "narrow with prefix=<namespace>". An agent reads that as "you did it wrong, retry narrower" —
a dead end that costs a round-trip and ends in the same answer. A hint must never propose the state the
call is already in; if the applied narrowing cannot help, say THAT ("narrowing does not lift this demote —
the blocking dynamic call is at <file:line>").

Naming the blocking call is the actionable half: today the caller cannot even find which `t()` caused it.

Same family as t-959904 (a refusal must name a step the caller can actually take) — this is its i18n
instance, with the extra sting that the proposed step is the one already taken.
