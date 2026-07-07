---
id: t-000039
title: "ts/plugin.ts` LS-read wiring split"
status: backlog
priority: medium
type: imp
importance: medium
complexity: M
area: phase-6
created: '2026-07-08T00:00:38.000Z'
---
**`ts/plugin.ts` LS-read wiring split** — `plugin.ts` carries a temporary
`/* eslint-disable max-lines */` (the five `resolvedScan`-routed reads + the two other
symbol-anchored methods pushed it past 300). Extract the LS-read wiring into a sub-module so the
file fits under the cap, then remove the pragma. Behavior-preserving (the methods' existing tests
are the oracle). `imp`·`med`·`cx:M`
