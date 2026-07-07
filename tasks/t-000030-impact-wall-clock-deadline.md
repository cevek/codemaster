---
id: t-000030
title: 'impact: wall-clock deadline'
status: backlog
priority: medium
type: perf
complexity: M
area: impact-usages
created: '2026-07-08T00:00:29.000Z'
---
**impact: wall-clock deadline** — node-cap guarantees termination but there's no cumulative
wall-clock budget → slow-but-finite on a huge repo. Needs a live `Clock` in `OpContext`
(engine-level). `perf`·`med`·`cx:M`
