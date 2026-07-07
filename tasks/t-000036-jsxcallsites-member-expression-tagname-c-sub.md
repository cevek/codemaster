---
id: t-000036
title: 'jsxCallSites: member-expression tagName `<C.Sub/>'
status: backlog
priority: low
type: bug
complexity: S
area: framework
created: '2026-07-08T00:00:35.000Z'
---
**jsxCallSites: member-expression tagName `<C.Sub/>`** — a ref to `C` inside a member-expr tagName
(`<C.Sub foo/>`) is classified `jsx` and Sub's attributes read as passed to `C` → `find_unused_props`
may mask a dead prop on `C` (false-negative) or falsely mark it used. Rare (compound components).
`bug`·`low`·`cx:S`
