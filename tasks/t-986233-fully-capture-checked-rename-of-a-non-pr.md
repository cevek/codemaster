---
id: t-986233
title: Fully-capture-checked rename of a NON-PRIMARY target in one call (sibling-overlay support)
status: backlog
priority: medium
depends_on:
  - t-773499
tags:
  - dogfood
  - multi-program
type: feat
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-15T22:00:15.447Z'
---
**Follow-up of t-773499.** Today `rename_symbol` on a symbol whose DECLARATION lives outside the primary program is REFUSED with a `root:<pkg>` redirect (the capture-safety gate is structurally primary-only — `setOverlay` / `withOverlay` live on the primary program only, ls-host.ts §). The safe path exists (re-run with the owning package as `root`, where its program is primary → full capture gate), but it is a SECOND call from a different root.

**Wanted:** rename a non-primary target in ONE call from the outer root, WITH the full capture-safety gate. That needs the capture detector (`refactor/capture/rename.ts`, `overlay-type.ts::withOverlay`) to run its post-edit overlay + reference re-resolution against the OWNING (sibling / isolated-package) program, not the primary — i.e. sibling-overlay support on a non-primary `SingleProgram`.

Same gap blocks the fully-checked FOREIGN widen probe in `impact_type_error` (t-733915 currently discloses `downstreamTrusted:false` instead of fanning the overlay to the owning program). Both are the one underlying capability: **primary-only overlay → any-program overlay**.

Scope: `plugins/ts/ls-host.ts` (per-program overlay set/clear), `plugins/ts/program/single.ts` (already has per-program overlay — expose it to the host cross-program surface), `refactor/capture/rename.ts` + `overlay-type.ts` (route the overlay to the owning program). Keep the §2.8 gate + capture-safety invariants; the one-call path must be as safe as the `root:<pkg>` path, never weaker.
