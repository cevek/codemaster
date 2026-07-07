---
id: t-000045
title: "trace_field_to_render: destructure-following"
status: backlog
priority: medium
type: feat
importance: medium
complexity: M
area: phase-6
created: '2026-07-08T00:00:44.000Z'
---
**trace_field_to_render: destructure-following** — `renderedBy` stops at `const {email}=u`
(destructure is the DOMINANT way a component reads a field), so it under-counts heavily — honest
(floored as LOWER BOUND), but a +1 hop following the destructured local to its render site would
cover the common path. The big completeness win for this op. `feat`·`med`·`cx:M`
