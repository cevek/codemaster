---
id: t-490634
title: 'EPIC: the feedback channel is write-only — codemaster produces findings it cannot enumerate, attribute, or mark processed'
status: backlog
priority: medium
type: dx
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-437713
  - t-826059
audience: both
evidence: measured
created: '2026-07-30T11:27:10.239Z'
---
## The class

The dogfood loop's whole value rests on `feedback` → inbox → backlog. The WRITE side is instrumented (repo,
version, op list, timestamp); everything downstream of it is not. Every honesty property codemaster enforces
on its own answers — a machine-produced denominator, no silent truncation, a stated scope — is unavailable
to whoever processes its findings, and the file is GLOBAL: agents from other repos append to it, so between
two drains entries appear that the draining agent was never told about.

Members cover the two missing halves: enumeration/drain (the reader) and attribution (who filed it).
