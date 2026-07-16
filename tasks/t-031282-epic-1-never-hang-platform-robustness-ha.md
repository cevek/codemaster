---
id: t-031282
title: 'EPIC: §1 never-hang & platform-robustness hardening (bound every unbounded path + survive/kill a wedge)'
status: backlog
priority: high
tags:
  - epic
  - platform
type: imp
complexity: L
area: platform
created: '2026-07-16T12:02:27.839Z'
---
Umbrella for the north-star §1 invariant ("never hang — the worst failure") and its neighbours (never-OOM at scale, wedge-survival). Motivated by the 2026-07-16 live incident (t-895142): an orphaned `mcp --in-process` server spun at 100% CPU for 46 min from an unbounded `walk.ts` symlink-cycle — the acute cause is now fixed (t-368812), but the incident exposed that the tool has **no backstop for a *future* unknown wedge** and **no bound on several known per-call/synchronous paths**.

**Two halves:**
1. **Bound every unbounded path** (remove the causes) — no synchronous op without a wall-time deadline; no per-call work that scales with repo size.
2. **Survive/kill a wedge** (defense-in-depth) — catch a future sync-spin from OUTSIDE the blocked event loop (a `worker_threads` breadcrumb watchdog in-process; the §9 process-mode orchestrator SIGKILL for the daemon) and leave a diagnostic breadcrumb.

**Constraint proven on the live wedge:** a synchronous busy-loop kills the event loop → signals, JS handlers, and `process.report` are all unserviceable. Only a separate thread (worker_threads) or an external process (§9 orchestrator) can act; `--report-on-signal` is useless against a sync spin.

Members: t-895142 (incident + acute fix t-368812 ✓ + watchdog t-095661), t-000059 (no wall-time bound on synchronous TS ops — the general form), t-000052 (process-mode engine isolation = the production hard-kill guarantee, §9; also unblocks t-167395), t-000051 (wedged-daemon recovery), t-000030 (impact: wall-clock deadline), t-000013 (detectReverseImportCaptures adds an O(repo) AST walk to every move_file/extract_symbol — per-call repo-scale), t-167395 (name-addressed OOM-crash at scale), t-324342 (non-git ≥500k tree → permanent partial residual).
