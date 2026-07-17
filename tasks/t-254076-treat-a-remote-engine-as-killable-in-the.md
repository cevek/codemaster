---
id: t-254076
title: Treat a remote engine as killable in the semantic-fanout guard — default 'in-process' isolation would over-refuse once remote createEngine goes through the EngineDeps seam
status: backlog
priority: low
parent: t-031282
tags:
  - platform
type: imp
complexity: S
area: platform
created: '2026-07-17T02:03:48.993Z'
---
Latent over-refusal surfaced by the t-679091 architecture-reviewer (not yet reachable — filed so it isn't lost).

The semantic-fanout guard (t-679091) refuses a heavy fan-out op when `EngineDeps.isolation === 'in-process'` (the default). Today only two createEngine sites set it: `host-build.ts` ('in-process') and `engine-child.ts` ('process'). When a REMOTE engine construction path eventually goes through the same `EngineDeps` seam and does NOT pass `isolation`, it inherits the default `'in-process'` → the guard would OVER-REFUSE a heavy fan-out op on a remote engine that is actually killable/memory-bounded (it survives an OOM the same way process-mode does).

This is FAIL-SAFE (refuse > crash), not a blocker, and unreachable until remote createEngine exists. When it lands: treat a remote engine as killable (either pass an explicit isolation value for it, or widen the guard's "safe" set beyond `'process'` to include remote). Small change; the trap is silent inheritance of the default. Add a discriminating test that a remote-configured engine is NOT refused.
