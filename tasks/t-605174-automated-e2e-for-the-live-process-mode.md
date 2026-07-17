---
id: t-605174
title: 'Automated E2E for the live process-mode path: mcp bridge → daemon socket → serve-engine child → op result (the keystone''s "не покрыто в изоляции")'
status: backlog
priority: medium
parent: t-031282
tags:
  - platform
type: feat
complexity: M
area: platform
created: '2026-07-17T01:30:07.343Z'
---
Closes the coverage gap t-000052 shipped with. The keystone's own e2e (`test/e2e/process-isolation.test.ts`) drives `createProcessHost`/`Orchestrator` DIRECTLY (process≡in-process byte-parity, SIGKILL-child→ToolFailure+respawn, SIGKILL-parent→child self-exit) — but NOT through the real `codemaster mcp` stdio↔socket BRIDGE → daemon → `serve-engine` child under a live client.

## Why it's still worth doing (low-risk, not zero)
The bridge passes `OpRequest[]→OpResult[]` over the socket and calls `orchestrator.request()` — agnostic to whether the host is in-process or process. So the untested combination is `tested-bridge ∘ tested-(orchestrator+process-host)`; the composition risk is low but real (serialization across BOTH hops, a JSON-shape or lifecycle interaction only the full stack exposes). An opt-in feature that a user turns on with `isolation:'process'` should have one end-to-end proof it works over the wire.

## Scope
An automated E2E: start a real daemon (the socket-dir seam) with a workspace configured `daemon.isolation:'process'`, connect a bridge, drive a representative op set (find_definition/find_usages/expand_type), assert results byte-equal to the in-process path (the §16 parity cousin, one level up from the keystone's direct test). Real-spawn (not manual-clock): event-driven waits, isolated socket-dir + temp state, own pids. Reuse the bridge-convergence + process-isolation test harnesses. Heavy runs via the machine-wide test-lock.

Do NOT force process-mode by committing a `codemaster.config.*` to the repo root (would change this repo's default + disrupt the live dogfood daemon) — drive it through the test seams.
