---
id: t-011315
title: '`codemod` IS the read op for declaration-shape questions, but its mutation label filters it out before an agent reads its semantics — capability present, correct, and structurally undiscoverable'
status: backlog
priority: high
parent: t-826059
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
relates:
  - t-000143
  - t-248218
  - t-566356
surface:
  - mcp
  - ops
audience: external
evidence: reported
created: '2026-07-28T16:47:56.881Z'
---
A new discoverability failure mode, and the cheapest one found so far: the capability EXISTS, is correctly
implemented, defaults to safe — and is filtered out by its own label before its semantics are ever read.

Reported by the worker that spent a whole track on the schema surface (t-029489 cluster). Its questions
were **declaration-SHAPE**, not symbol identity:
- which ops declare `force: z.boolean().optional()` (16)
- who has `pathInclude` as an array vs a string
- which schemas refine through `requireTarget.predicate` (15)

`find_usages` on a zod field name is meaningless — that is an object-literal key, not a symbol. So grep was
correct BY TYPE of question, and the track had zero alias/re-export misses because it was not searching for
symbols. Worth recording as such: not every fallback to grep is a defect (see t-089408).

But `codemod` answers exactly this class — ast-grep structural match, **dry-run by default**, i.e. a
read. The agent did not reach for it, and says why: it is named as a mutation and carries
`[mutating: dry-run unless apply:true]`, so an agent holding a READ question discards it while scanning
the catalogue, before ever reading what it does. It only came to mind during the write-up.

Fix is labeling, not capability:
- state the read use FIRST in the summary/argsHint — "structurally match a code shape across the repo
  (dry-run: a query); with `apply:true` also rewrites";
- keep the mutating marker, but stop it being the first thing an agent filters on;
- cross-reference from where the question actually arises: `find_usages` / `search_symbol` notes could name
  `codemod` for "match a declaration SHAPE, not a symbol".

Same family as t-248218 (`impact_type_error` framed by its output, not the question it answers) — but
sharper, because here the label actively causes the wrong filter rather than merely failing to attract.
