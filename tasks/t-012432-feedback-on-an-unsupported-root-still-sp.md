---
id: t-012432
title: feedback on an unsupported root still spawns a full engine — watcher + an LRU slot that can evict a warm workspace
status: backlog
priority: medium
tags:
  - dogfood
  - platform
type: perf
complexity: M
area: platform
relates:
  - t-810757
surface:
  - daemon
audience: internal
evidence: repro
created: '2026-07-30T16:17:33.504Z'
---
`OpDefinition.workspaceIndependent` (t-810757) lets `feedback` past the §4c TS-project gate, and the
op itself touches no plugin, no program and no LS. Reaching it does not stay that cheap: the
orchestrator's only path to dispatch is a real engine, so a `feedback` call from ANY directory —
which is the entire point of the flag — constructs the plugin set, attaches a RECURSIVE watcher to
that root (`daemon/engine.ts`, watcher started in the engine constructor), opens a per-repo debug log
sink, registers an engine slot and runs `enforceGovernor()`.

The sharp edge is the governor: `maxEngines` defaults to 8, so filing a wish from a scratch dir or
`$HOME` can evict the LRU workspace — potentially the multi-GB warm LS the daemon exists to amortize
— in favour of a root codemaster just declared uninspectable. On Linux a large non-TS tree also
spends inotify watches (degrades honestly per §19, but the cost is real).

Not a correctness defect: nothing lies, and the op answers. It is a resource/lifecycle cost the
design note originally claimed was not paid; that note now states the real profile and points here.

Fix shapes, none free:
- a no-engine dispatch path for workspace-independent ops (the op needs only `ctx.daemon`, which the
  orchestrator can assemble) — cleanest, but duplicates a slice of `runOne` unless that is factored;
- spawn WITHOUT registering the slot and dispose after the request — no governor pressure, but a
  spawn per call and two lifetimes to keep straight;
- register but make an `unsupported` slot the preferred eviction victim — smallest, and leaves the
  watcher cost in place.

Whichever is chosen, the `feedback`-from-anywhere case is the one to measure: it is the call the
flag exists for, so its cost is the flag's real cost.
