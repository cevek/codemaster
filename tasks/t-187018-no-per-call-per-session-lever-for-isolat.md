---
id: t-187018
title: No per-call / per-session lever for isolation or heap — the only path is writing codemaster.config INTO the inspected repo, which per §10 EVICTS every other client's engine and re-spawns them into your sandbox
status: backlog
priority: high
tags:
  - dogfood
  - platform
type: feat
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-544207
  - t-847874
  - t-972931
  - t-980509
surface:
  - daemon
  - mcp
  - support
audience: external
evidence: repro
created: '2026-07-28T08:26:59.251Z'
---
`root` selects the repo per call, but `isolation` and `maxOldSpaceMB` come ONLY from `codemaster.config.*`
resolved from that repo's root. So verifying the §9/§19 child-OOM claim required WRITING a config file
into someone else's actively-worked repo (backoffice2) and removing it after.

Three real costs, the second of which is a genuinely surprising blast radius:
1. an untracked file appears in another team's `git status` for the duration;
2. per §10 the config fingerprint is checked on EVERY request — so the experimenter's temporary file
   **evicted the engine for every other client of that repo and re-spawned them into the experimenter's
   1 GB process-mode sandbox**. The worker only noticed while writing the report. A local experiment
   silently reconfigured everyone else's runtime.
3. a read-only or foreign checkout cannot be run in process-mode at all — there is no read-only path to
   the isolation guarantee, which is exactly what you want on an unfamiliar oversized repo.

The right shape already exists as precedent: `CODEMASTER_SOCK_DIR` is per-PROCESS, not per-repo, and let
the same worker run a fully isolated daemon without touching the target repo — frictionless. The gap is
that the two knobs actually needed have no such escape.

Any one of these closes it: env overrides mirroring the socket-dir precedent
(`CODEMASTER_ISOLATION`, `CODEMASTER_MAX_OLD_SPACE_MB`); a per-call flag on the op; or a session-scoped
setting at the MCP/bridge layer. Env is the cheapest and matches an existing, proven pattern.
