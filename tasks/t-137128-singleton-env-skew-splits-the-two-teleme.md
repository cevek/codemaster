---
id: t-137128
title: "Singleton env skew splits the two telemetry views: the daemon inherits the first bridge's CODEMASTER_USAGE_DIR, so a later bridge's records and the daemon's breadcrumbs land in different dirs"
status: backlog
priority: low
tags:
  - platform
type: bug
complexity: S
area: platform
created: '2026-07-28T07:26:38.056Z'
---
Telemetry ownership is split by role: the agent-facing process writes the one accounting record per call, the daemon writes only its own in-flight crash breadcrumbs. Correlating a fatal means matching the two views on `cwd` + `ops`, which requires both to be in the SAME usage directory.

They can diverge. `defaultUsageLogger()` resolves `CODEMASTER_USAGE_DIR` (else `$HOME/.codemaster/usage`) from each process's own environment, and `daemon/spawn-daemon.ts` gives the daemon the environment of whichever bridge first spawned it. The daemon is a machine-wide singleton serving every later bridge, so a bridge started with a different `CODEMASTER_USAGE_DIR` writes its accounting records somewhere the daemon's breadcrumbs are not — and a bridge started with `CODEMASTER_USAGE_LOG=0` writes none at all while the daemon keeps stamping breadcrumbs (or the reverse).

Consequences: the two views of one fatal cannot be correlated, and the closed-link message's pointer at the usage log sends the reader to the wrong directory.

Note the deliberate contrast: the SOCKET path is already env-independent for exactly this class of reason (§19 uses `os.userInfo().homedir`, never `$HOME`, so the bridge and the management verbs cannot compute different paths and split the singleton). The usage dir has no such rule.

## Fix directions

- Resolve the usage dir the same env-independent way the socket path is resolved, leaving `CODEMASTER_USAGE_DIR` as an explicit override that the daemon is told about rather than inheriting by accident.
- Or have the daemon report its resolved usage dir in `daemon-info`, so a bridge can detect the skew and say so instead of pointing at a file that does not hold the other half.

Mostly bites tests and multi-config setups; production agents share one environment.
