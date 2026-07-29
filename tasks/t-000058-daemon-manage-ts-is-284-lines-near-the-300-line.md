---
id: t-000058
title: daemon/manage.ts` is ~284 lines — near the 300 line-cap
status: backlog
priority: low
type: dx
complexity: S
area: platform
relates:
  - t-000166
  - t-835831
surface:
  - daemon
audience: internal
evidence: measured
created: '2026-07-08T00:00:57.000Z'
---
`src/daemon/manage.ts` sits close to the 300-line cap, so the next behavioural change to a verb hits it.

The seam that works is already demonstrated: `manage-probe.ts` holds the "what is at the socket" machinery (`Probe`, `probeDaemon`, `awaitRelease`, `fetchInfo`, `describe`) and depends on a narrow `ProbeDeps` — a transport and a clock — rather than the verbs' `DaemonManageDeps`. Narrowing the dependency is what keeps it a one-way edge instead of a cycle; `manage-io.ts` is the same pattern one level lower (the request/reply + close primitives). Split the next verb-level concern out the same way rather than raising the cap.
