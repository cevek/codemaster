---
id: t-000170
title: "find_unused_exports.undiscoveredPrograms` lists ABSOLUTE paths"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:49.000Z'
---
**`find_unused_exports.undiscoveredPrograms` lists ABSOLUTE paths** — `/Users/…/tsconfig.json`
while every other path in every op is repo-relative — inconsistent, and leaks the absolute FS
layout. Make it repo-relative. `bug`·`low`·`cx:S`
