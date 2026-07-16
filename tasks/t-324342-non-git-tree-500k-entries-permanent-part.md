---
id: t-324342
title: non-git tree ≥500k entries → permanent partial/unverified freshness (walkFiles entry-cap; honest degradation, non-git roots only)
status: backlog
priority: low
parent: t-031282
tags:
  - platform
type: imp
complexity: M
area: platform
created: '2026-07-16T11:43:56.040Z'
---
**Residual from t-368812** (§1 never-hang walk fix). `support/fs/walk.ts` caps at `DEFAULT_MAX_ENTRIES = 500_000` entries → on a genuinely huge NON-GIT source tree the walk returns `partial{tool:'fs', 'entry cap … reached'}`, so `daemon/freshness.ts` mtime-walk mode carries a permanent `unverified` freshness (never a clean commit anchor).

**Honest degradation, NOT a correctness bug** — the answer is disclosed `partial`/unverified, never a silent-stale/complete lie (§3.4/§3.5). Blast radius is bounded to **non-git roots only**: a git repo lists files via `git ls-files` and never hits `walkFiles` for freshness. Filed so it is not lost, not because it currently misleads.

**If ever addressed:** a bounded incremental/streamed fingerprint for >500k-entry non-git trees, or a configurable cap surfaced in `status`. Until then the cap is the correct §1 bound (a hang is worse than an honest partial). Verify on a real ≥500k non-git tree before any change.
