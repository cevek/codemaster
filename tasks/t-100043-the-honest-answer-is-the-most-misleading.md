---
id: t-100043
title: 'The honest answer is the most misleading one: `member_usages` returns sites=1 where 6 consumers exist, because the type edge is SEVERED at the ops→JsonValue seam — `complete:false` discloses the program floor and is silent about the larger hole'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T17:29:50.314Z'
---
A new honesty class, measured. Nothing lied; the disclosure worked; the reader is still misled.

Setting: a worker was changing the SEMANTICS of `I18nUnusedView.degraded`, so every consumer encoding the
old contract had to be revisited. `member_usages` is exactly the right op for that.

```
member_usages {name:'I18nUnusedView', member:'degraded'} → sites = 1
```

Real consumers: **6** — the one it found, plus five test files, **four of which encoded the old contract
and needed repair**.

**Why, and it is not a defect of the search:** the type edge DOES NOT EXIST. The op returns
`Result<JsonValue>`; a test reads it back as `res.result.data as View`, where `View` is a locally declared,
structurally similar type. The checker has nothing to link — member references die at the
ops → `JsonValue` serialization seam. `impact_type_error` would not help either, for the same reason: tsc
sees no edge to break.

So the answer `total=1 complete=false` is impeccably honest about the PROGRAM floor and silent about a
hole an order of magnitude larger. In the reporter's words:

> Честная `1` здесь — самый вводящий в заблуждение из истинных ответов, потому что вопрос перед сменой
> контракта никогда не «сколько типизированных ссылок», а «что сломается».

This is NOT silent truncation (§3.4) — the count is right and the floor is disclosed. It is a **silent
scope mismatch**: the question maps onto a different set than the one the tool measured, and nothing in
the answer signals that the two diverged.

Measured cost: an extra round — the fourth stale consumer surfaced only on the full suite at DONE, costing
a suite run and a fifth commit. The worker had already fallen back to grepping PRODUCERS
(`unusedKeys`/`dynamicDemotion`) because `degraded` is too common a word to grep directly.

Two asks, the second cheaper and more important:

1. `member_usages {text:true}` — semantic ∪ textual, exactly as `find_usages` already does it. The
   precedent and the honesty model exist (a text-only hit is `unresolved`, deduped against semantic
   hits), and it lands precisely where the edge is cut.
2. **Say that the edge may be severed.** A type that leaks into an op's `data` as `JsonValue` is a
   SYNTACTIC property of this repo and is detectable: when the queried declaration is reachable from a
   `Result<JsonValue>` boundary, the answer should disclose that consumers past that seam are invisible to
   the checker. That turns a true-but-misleading `1` into an actionable one.

Related family — all "static references are not what breaks": t-340801 (cannot anchor on a node_modules
type), t-045024 (render tree ≠ reference graph), t-159797 (callback exit paths). This one is the sharpest
because the tool was RIGHT and the reader was still wrong.
