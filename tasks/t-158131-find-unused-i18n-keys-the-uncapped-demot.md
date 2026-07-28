---
id: t-158131
title: 'find_unused_i18n_keys: the uncapped demoted-namespace set is unreachable in partials:list/hide and sql modes'
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
relates:
  - t-529726
surface:
  - ops
  - plugins/i18n
audience: external
evidence: repro
created: '2026-07-28T17:13:14.756Z'
---
`degradedReason` names the demoted namespaces through `nameWithMore(reachedPrefixes, 3)` — it
renders ahead of the rows, so the list is capped there (§12 verdict-before-bulk). The uncapped set
reaches the agent only through the op's `partial.demoted` array, which is emitted **only in
`partials:'summary'`**. Under `partials:'list'`, `partials:'hide'` and sql-mode the capped prose is
the only namespace signal, with no stated way to get the rest (CONTRIBUTING, "Output is the
product": cap with an explicit "N more + how to narrow").

Repro — five demoted namespaces, `{"partials":"list"}`:

```
degradedReason=a dynamic t(`…`) demotes namespace(s) n1., n2., n3., +2 more — unrelated keys stay certain
```

Not a §3.4 silent truncation (the `+N more` is explicit), and in `list`/sql the per-row `confidence`
still carries the underlying per-key fact — which is why this is small. The gap is the missing
recovery path.

Fix shape: forward `view.demotedPrefixes` (the plugin already exposes the whole-scan set) in the
op's head when the `partial` summary block is not emitted, or name the retrieval in the reason.
Whichever, keep it out of the verdict-first bulk.
