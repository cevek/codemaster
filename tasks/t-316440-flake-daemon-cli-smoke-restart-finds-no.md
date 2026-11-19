---
id: t-316440
title: 'Flake: daemon-cli-smoke restart finds no daemon under two concurrent full runs'
status: backlog
priority: medium
created_by_session: s-363919
type: bug
complexity: S
evidence: measured
author: mb-c5e4101d
created: '2026-11-19T08:27:50.597Z'
---
`test/e2e/daemon-cli-smoke.test.ts` («daemon CLI: status → start → status → stop → status → restart over a real socket») failed once: `restart bound a fresh daemon (was 1222148, now undefined)`, last status `no daemon running`, after 27.7 s. Context: mini (Linux, 16 CPU, Node 24, load ~35 from other agents), two concurrent full `npm test` runs of 75d0d03 (cpu-slots) from separate copies; 1 of 4 such tip runs, 0 of 4 base runs (single + concurrent).

The daemon is spawned detached by `spawnDaemon` (`src/daemon/spawn-daemon.ts`, `spawn(process.execPath, …)`, no preload) — it holds no CPU slot and runs outside the test file's one. Cause not established: whether the restart's start deadline is too tight under load, or the stop/restart sequence races. Reproduce deterministically before changing anything.
