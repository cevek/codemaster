---
id: t-000041
title: 'trace_type_widening: non-modeled flow caveat'
status: backlog
priority: low
type: bug
complexity: S
area: phase-6
created: '2026-07-08T00:00:40.000Z'
---
**trace_type_widening: non-modeled flow caveat** — forward-flow models 4 relations (var-init /
arg→param / return / reassign). Flow through property-assign (`obj.f=c`), element (`[c]` / `push`),
spread, template → `resolveSink` returns undefined, silently not traced (safe — under-report, never
false-widening, documented as 4 relations). Add a caveat note when the value has ref-sites matching
none of the 4 sink types, so `0 widenings` isn't read as "no widening anywhere". `bug`·`low`·`cx:S`
