---
id: t-000035
title: 'impact_type_error: overlay-baseline doc wording'
status: backlog
priority: low
type: dx
complexity: S
area: phase-5
created: '2026-07-08T00:00:34.000Z'
---
**impact_type_error: overlay-baseline doc wording** — the overlay-check doc (`ts/api.ts`) says "disk
baseline" but `collectFromService` reads the CURRENT program state (=VFS), not disk. Cosmetic doc
accuracy. `dx`·`low`·`cx:S`
