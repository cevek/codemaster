---
id: t-312942
title: 'find_usages props filter: value comparison is raw source text — a JSX entity (x="a&amp;b") never matches a decoded query string'
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-28T16:22:54.402Z'
---
`readAttribute` (src/plugins/ts/jsx-attr-values.ts) takes `init.text` for a string-literal
attribute, and TypeScript does NOT decode JSX entities: `x="a&amp;b"` yields the literal text
`a&amp;b`, not `a&b`. So `props:{x:['a&b']}` misses that site.

Disclosed in the op notes (values compare as SOURCE text), so it is not a silent lie — but the
normalization promise ("`x=\"a\"` and `x={'a'}` compare equal") does not extend to entities, and an
agent auditing a label-bearing prop can under-count.

Fix: decode JSX entities on the literal path (and say so), or normalize the QUERY the same way so
both sides are raw.
