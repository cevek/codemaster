---
id: t-095661
title: 'never-hang defense-in-depth: worker_threads breadcrumb watchdog (in-process) + §9 daemon kill-on-deadline + getppid poll backstop'
status: done
priority: high
parent: t-895142
depends_on:
  - t-368812
tags:
  - platform
type: feat
complexity: L
area: platform
created: '2026-07-16T11:06:41.218Z'
---
**SHIPPED: backstops 1 + 2** (the in-process defense-in-depth). **Backstops 3 and the fold-ins split into their own tracked tasks** — see below.

## What shipped (`src/support/watchdog/`)

**Backstop 1 — worker_threads breadcrumb watchdog (in-process).** A process-global `beacon` (module singleton) that engine code wraps each heavy op in via `beacon.measure(label, args, fn)` — cheap: it registers a breadcrumb (op label + bounded args preview + start-time) in a `SharedArrayBuffer` slot before the op and removes it after. Because production runs CONCURRENT non-nested ops on the one main thread (several engines share the beacon, unserialized), the beacon tracks a LIVE SET keyed by identity and publishes the OLDEST live op (the wedge candidate) to the slot — NOT a LIFO stack, which would pin a completed op's ancient start and false-kill a healthy process under churn (the reviewed BLOCK). A worker thread on its own un-wedged timer reads the slot; past a generous threshold (`CODEMASTER_WATCHDOG_MS`, default ~5 min — §1: no legit op approaches it) it writes the breadcrumb to `~/.codemaster/stalls/<ts>.json` then `process.kill(pid,'SIGKILL')`. SIGKILL, not `process.abort()`: abort is UNSUPPORTED in a worker (`ERR_WORKER_UNSUPPORTED_OPERATION`, verified), and SIGKILL is kernel-delivered + uncatchable → bypasses the wedged loop. Breadcrumb sites: `engine.runOne` (op), `engine.refresh` (freshness walk — the incident's own wedge site), `createEngine` plugin.init.

**Backstop 2 — getppid/orphan poll.** Main-loop poll (existence-probe `kill(parentPid,0)` → ESRCH/EPERM, robust vs cached `process.ppid`); on the spawning parent's death → SIGTERM self → the server's existing graceful shutdown. Wired ONLY on `mcp --in-process`; DISABLED for `daemon serve` (detached by design — parent legitimately becomes init). The worker also SIGKILLs a WEDGED orphan as backstop (grace ticks let the graceful poll win first).

Installed on both in-process composition roots (`mcp --in-process` orphan-aware; `daemon serve` wedge-only). Best-effort: a failed install is a no-op, never a broken serve path. Inactive-by-default seam (no `bind` → `measure` is a bare passthrough), so non-watchdog paths pay nothing (§16 determinism).

Tests: `test/unit/watchdog-{beacon,orphan,stall-dir,engine-wiring}.test.ts` (fake-clock + active-beacon engine wiring), `test/e2e/watchdog-smoke.test.ts` + `watchdog-harness.ts` (real-spawn: worker reaps a genuine wedge → SIGKILL + stall file; orphan is reaped not lingering). Reviewed by architecture-reviewer + bug-reviewer; the one BLOCK (concurrent-ops LIFO corruption → false-kill) fixed + covered by a discriminating test.

## Split out (NOT in this task)
- **t-063850** — backstop 3: §9 daemon kill-on-deadline (per-child SIGKILL by PID). Blocked on t-000052 (process-mode engine isolation) — the production hard guarantee, more precise than the same-process watchdog.
- **t-140171** — fold-in: fire a stall breadcrumb on the §19 cancellable-deadline path (the `HostCancellationToken` path isn't built yet — nothing to wire into today).
- **t-826996** — extend breadcrumb coverage to the spawn/routing path (config-load / getOrSpawn / daemon routing loop) — a MISSED-wedge coverage gap (safe direction), not a false-positive.
