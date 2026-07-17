---
id: t-679091
title: Refuse heavy semantic fan-out ops (find_usages/impact/importers_of) on an oversized in-process repo — honest redirect to isolation:'process' instead of OOM-crash
status: backlog
priority: high
parent: t-031282
tags:
  - dogfood
  - multi-program
  - platform
type: feat
complexity: M
area: platform
created: '2026-07-17T01:14:45.323Z'
---
The backstop residual of t-167395, direction pinned (advisor-confirmed). t-000052 shipped the process-mode MECHANISM (per-engine `--max-old-space-size`, child-exit→ToolFailure{oom}, respawn) but it is OFF by default (`isolation` defaults `in-process` per ARCHITECTURE §2, "in-process — default at this stage"). So under the DEFAULT config a genuinely-heavy SEMANTIC fan-out op (find_usages on a references-monorepo where Fix A's discovery-pruning does NOT subsume) still fans the LS across all programs → OOM → kills the singleton in-process daemon (uncatchable, §1). Fix A (search_symbol discovery pruning) + the t-333163 size-guard only cover `search_symbol`; both explicitly do NOT guard the semantic ops ("their fix is process-isolation §2").

## The fix (3.5 — the direct analogue of the accepted t-333163 pre-warm guard)
§1 requires "don't crash", NOT "make the op succeed". So convert the uncatchable OOM-crash into an honest refusal: when the engine is `in-process` AND the repo exceeds the same cheap file-count estimate the size-guard already computes (`estimateSourceFileCount` / the §10 git-source surface, no program build, no LS warm), a heavy FAN-OUT op REFUSES with an actionable `ToolFailure` — "repo too large for in-process semantic fan-out — set `daemon.isolation: 'process'` in codemaster.config" — instead of warming into an OOM. Strictly better than today (a daemon-kill → an actionable refusal); one config line restores the capability, nothing permanently lost.

## Scope precisely
- Guard the FAN-OUT ops: `find_usages`, `impact`, `importers_of` (they fan the LS across programs = the OOM surface).
- Do NOT guard `find_definition` (single containing-program resolve, cheap — guarding it would be a false-refusal).
- Only when `isolation==='in-process'` (process-mode already survives via the t-000052 mechanism — no refusal there).
- `force:true` per-call override (mirror the size-guard). Reuse the size-guard's estimator + threshold config (`searchWarmMaxFiles` or a sibling `semanticFanoutMaxFiles`).

Reuses t-333163's guard code + adds the semantic-op entry points. Small clean track. Honest-degradation, never-lie/never-hang consistent.
