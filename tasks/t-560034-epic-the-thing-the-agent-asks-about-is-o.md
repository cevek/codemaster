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
