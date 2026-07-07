---
id: t-304222
title: Op to find exhaustive `switch`/if-chains discriminating on a union type T — incl. scrutinees reached via property access (find_usages-on-the-name structurally under-covers)
status: backlog
priority: medium
tags:
  - dogfood-jul
type: feat
importance: medium
complexity: L
area: impact-usages
created: '2026-07-07T20:06:00.123Z'
---
Inbox entry 24 (`task-manager`, widening union `FieldType`), 2026-07-04. When widening a discriminated union, THE correctness-critical query is "which `switch`/if-chains must I update to stay exhaustive?" `find_usages` on the type NAME finds annotation sites but **structurally misses** a `switch (spec.type) { case 'enum': … }` where `spec: FieldSpec` and `FieldSpec.type: FieldType` — the identifier `FieldType` never appears at the switch (the discriminant's type is `FieldType` only via property access on `FieldSpec`). Trusting `find_usages` as the switch inventory ships a non-exhaustive switch; `tsc` only catches it when the cases happen to be string-literal-narrowed and there's no `default` (luck).

Ask: `exhaustive_switches({type:'ts:FieldType'})` (or a `role:'discriminant'` filter on `find_usages`) returning every `switch`/if-chain whose scrutinee's **resolved type** is — or is assignable from — the union T, including scrutinees reached via property access (`x.type`) or aliasing where the type identifier never appears at the switch. This is the "what must I update to stay exhaustive?" query the name-search under-covers. Sibling of t-000175 (member-level find_usages) — both are type-driven rather than name-driven reference queries.
