---
id: t-560034
title: 'EPIC: the thing the agent asks about is often not a DECLARED TS symbol — record keys, top-level statements, value-object members, call arguments have no address'
status: backlog
priority: medium
type: feat
complexity: L
area: ts-core
source: dogfood-jul
relates:
  - t-250147
  - t-437713
  - t-675220
  - t-826059
  - t-934520
audience: external
evidence: repro
created: '2026-07-30T11:22:40.024Z'
---
## The class

Every addressing op takes `symbolId | name | file+line+col`, i.e. it requires a DECLARATION. A recurring
share of real questions is about an entity that is not one — and in each case the fallback is grep, which is
not merely coarser but UNSOUND for exactly the site that matters:

- a **key of a string-keyed record** — grep finds `draft.quantity` and cannot find `draft[field.key]`, the
  dynamic accessor that decided the whole fix;
- a module's **top-level executable statements** — a CLI dispatcher is absent from the name catalogue, so its
  existence is not even visible;
- a **member of a value/context object** — an aliased read (`const {x: fn} = useCtx()`) does not appear under
  that name, so a clean grep can be a false "dead";
- a **call argument at position N** — "which sites pass a literal that this new gate would refuse".

Each member is independently useful and independently landable; they share one root (the addressing
vocabulary) and one honesty requirement: whatever cannot be resolved must come back flagged `dynamic` /
`partial`, never as a hit list that looks complete.

The sibling epic for NON-CODE nodes (package.json / hooks / CI / prose) is separate — those are not TS at
all. This epic is about TS entities that the checker can see but the address space cannot name.

## Read as one set, 18 field reports converge on four unnamed places — and on one sharp danger

A thematic pass over 18 wish/friction reports (2026-07-30..08-05; amiro 11, task-manager 5, claude-ui 2) read consecutively rather than one at a time. The conclusion is not visible from any single entry.

Every one of the 18 hits the same wall: **only a DECLARED NAME is addressable.** The decisions code actually turns on live in four places that have no name:

1. **POSITION** — what sits in argument N, who built it, whether it is the same across all sites (5 reports)
2. **SHAPE** — "where else is it done this way": AST pattern, array-access form (`content[0]` vs `map`), assertion cast, a call's surroundings (5)
3. **LITERAL** — a string that IS the entity's identity: collection key, permission code, union-protocol discriminant, co-varying literals (4)
4. **DIRECTION** — where a value gets to: forward call path, field → request body, import cycle (4)

**What makes this priority rather than cosmetics: in every report that names an outcome, the miss is SILENT.** A bare value reads as "clear the field" (quiet data loss); a diverged key wipes state on every reload; a removed server-side code greys a button for all roles; the second consumer of changed semantics is found by a reviewer; a cycle is found by a human. Not one of these produces a red type or a red test. So the class where we promise the most value — proof instead of reading by eye — is exactly the class where we are absent.

### The sharper finding: the documented anti-join AMPLIFIES a wrong premise

"Which member of the family does NOT call F" answers confidently and completely when the premise inside F is false — e.g. the guard shipped under a different name. The set is complete, the counters are right, and only the hypothesis is wrong.

Our four documented limits on that recipe (one-member-per-file, helper-file over-report, completeness floors, `role:'call'`) do NOT cover this: every one of them is about completeness of the SET, none about correctness of the PREMISE. Until an op can prove reachability — that F calls nothing resembling X — a confident "not found" in an audit stays the most expensive answer we know how to produce. That gap is `t-904217`.

### Planning lever

Half the 18 close with ONE thing: make the expression in argument position an addressable object (its value, its literal, its producer, its origin — with honest `dynamic` where the producer is invisible). The other half close with structural search that returns SITES rather than a diff (`t-127800`). Treat those two as the axes; the individual wishes are instances.
