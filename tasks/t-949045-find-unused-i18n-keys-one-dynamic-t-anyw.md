---
id: t-949045
title: 'find_unused_i18n_keys: ONE dynamic t() anywhere demotes every key globally, so `prefix=` narrowing changes nothing — and the hint recommends the exact remedy the caller already applied'
status: done
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

## Resolution

The verdict and the hint are now scoped to what a call REPORTS, and the blocking call sites are
named (`blocking`: proof spans in `file:line:col` order, capped with its own inline `more`). Per-key
confidence is untouched — it stays the whole-scan fact, so the false-certain-dead surface did not
move. The two causes that HIDE keys rather than demote them (a locale parse failure, an unresolved
i18n module) stay whole-scan, so an empty answer over an unreadable locale still reads incomplete.
`globalDemote` stays the whole-scan fact, distinct from `degraded`.

**Measured, so the next reader does not re-open it: the "narrow the demote where the dynamic call
provably cannot reach the queried prefix" direction is not what fixes the reported repo.** In amiro
the dynamic `t()` population is **68 headless calls** (`t(row.labelKey)`, `t(kindLabelKey(kind))`,
`t(key)`) and **0** leading-substitution templates. A suffix bound (`` t(`${x}.title`) `` ⇒ the key
provably ends with `.title`) is implementable and sound, but fires on **0/68** there — so it was NOT
built: it would rewrite `isKeyDemoted`, the single predicate between the tool and a deleted
production string, for zero measured benefit. The second, provable instance of the same defect —
`{prefix:'ui'}` stamped `degraded` by a call confined to `errors.codes.*` — is what was fixed instead,
and it needs no new inference at all.

The only path that would lift the demote on those 68 calls is the checker's argument type
(literal unions) — a `plugins/ts` surface, filed as **t-529726**.
