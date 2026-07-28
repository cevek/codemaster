---
id: t-791164
title: impl + the interface method it implements are ONE entity for a usage question, but ambiguity treats them as two — so every "who consumes this plugin seam" question fails its first call, and the repo's own architecture makes that shape near-universal
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-161435
  - t-821130
  - t-826059
surface:
  - ops
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-28T19:48:02.563Z'
---
Measured by worker cb8fedab after finding the third proven-absence instance (t-194771) by grep, then
checking what the tool would have given:

```
find_usages {name:'firstParamTypeMembers', groupBy:'enclosing'}
  → FAIL, ambiguous: 2 declarations
    — implementation in plugins/ts/first-param-members.ts
    — interface method in plugins/ts/api.ts

find_usages {…, mergeDeclarations:true}
  → 2.2 s, exactly the right answer:
    unusedProps@plugins/react/plugin.ts:88
    checkPropDeclared@ops/trace-prop-through-tree-walk.ts:210
    (grouped by the enclosing FUNCTION, + an honest !! LOWER BOUND for 3 unloaded fixture tsconfigs)
```

**The tool WINS on capability and loses on the first call.** Grep returns `file:line` that must be opened
and read to learn whether it is even the same question; codemaster names the enclosing function
immediately. That is exactly the "location is not the answer" gap recorded in t-631032 — and here the tool
closes it.

And the failure is not a bug: two declarations genuinely exist, the message is honest, and it names
`mergeDeclarations:true` itself. The problem is the SHAPE, and this repo's own architecture makes it
near-universal: every plugin method is declared on the `api.ts` interface and implemented in its own
module, so ANY "who consumes this seam" question about a plugin API lands on it.

**Conceptually, an implementation and the interface method it implements are ONE entity for a usage
question, not an ambiguity.** The existing collapse (t-128204) merges candidates by RESOLVED DEFINITION —
impl and interface method are different definitions, so they legitimately survive it. This is a distinct
sub-case that the collapse rule does not and should not cover by accident.

Asks, in order:
1. recognize the impl ↔ interface-method pair and answer as one symbol WITH disclosure — per-site
   `decls[i]` already exists in the output, so attribution stays exact and nothing is silently merged;
2. minimum, if (1) is too much: lead the refusal with `mergeDeclarations:true` rather than with the
   SymbolId list. The list is the remedy for REAL ambiguity; here the cheap path is at the end of the
   sentence and costs the agent a full read to reach it (§12 verdict-first, applied to a refusal).

Economics the reporter states plainly, and it is why this matters beyond one call: **grep costs one call,
the tool costs a decision plus often two calls.** Closing (1) removes the second call for the most common
shape in this codebase.
