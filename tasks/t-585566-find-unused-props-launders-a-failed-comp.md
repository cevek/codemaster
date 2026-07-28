---
id: t-585566
title: find_unused_props launders a failed component lookup into ok{found:0} — and its own test pins that shape as correct
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-28T11:43:40.965Z'
---
`react.unusedProps` returns `{ok:false, message}` both when `pickComponent` finds no component and
when the ts seam reports an unresolved target (`plugins/react/plugin.ts`). `ops/find-unused-props.ts`
converts that into `ok{component, found:0, notes:[message]}`.

On the SUCCESS path `found` is the number of UNUSED props. So "no such component" and "this component
has no dead props" are byte-identical in shape:

```
find_unused_props {component:'Nope'}
→ ok {"component":"Nope","found":0,"notes":["no detected React component named 'Nope' — …"]}
```

The op's own note (`find-unused-props.ts`) claims "never an empty success" — the code contradicts it.

`test/differential/unused-props.test.ts` ("honest non-result: unknown component reports found:0 with a
note, not an empty success") pins the laundered shape as the contract, so fixing the op means
re-pointing that test to assert a `ToolFailure` carrying the resolver's message — a strengthening, but
one to make deliberately.

Same defect class as the two trace ops fixed in t-439939, milder in direction (an agent does not
delete code on "no unused props"). It survived that task's audit because the audit grepped the helper
NAME (`notFound`) rather than the SHAPE — this instance is not named that. Grep for the shape:
`ok({… found: 0 …})` built out of a resolver's `string` / `unresolved` arm.

Fix: fail with the resolver's message; keep `found:0` for a component that resolved and has no unused
props — the fact the op actually established.
