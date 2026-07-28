---
id: t-610052
title: trace_field_to_render answers found:1 renderedBy:0 for a target that is not a property — a const/type/component reads as a field nothing renders
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T11:43:52.973Z'
---
`trace_field_to_render` accepts a bare name for `field`, but nothing checks that the resolved
declaration IS a property. `findDefinition` + `scanMemberRefs` work on any symbol, so a const, a type
alias, a class or a component resolves and answers:

```
trace_field_to_render {field:'NOTAFIELD'}   // export const NOTAFIELD = 41
→ ok {"field":"\"./m\".NOTAFIELD","found":1,"renderedBy":0}
```

`found:1` positively asserts the field was found. Passing a type or component name instead of a
property name is a plausible agent mistake, and the answer reads as "that field is rendered nowhere".

The op's `notes` now DISCLOSE this rather than claiming otherwise (§3.6), which is the honest stopgap;
the fix is a kind gate.

Material for the gate: `fieldView.kind` is `property` for every real field (interface member, type
member, class field, object-literal property) and `const` / `type` / `class` / `method` for the rest.

CAREFUL with the allowlist — over-refusal is the worse error here (§7): `getter` and `setter` legitimately
reach a render, and `method` may. A gate that refuses them turns a working query into a dead end. So
this needs its own scope: decide the allowed kinds, refuse the rest with a message naming what was
addressed and its kind, and cover BOTH directions with tests (a getter still traces; a const refuses).
