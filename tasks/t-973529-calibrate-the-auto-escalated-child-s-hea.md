---
id: t-973529
title: Calibrate the auto-escalated child's heap ceiling — an oversized fan-out grinds ~6.6 min before OOM instead of failing fast
status: done
priority: urgent
parent: t-754922
tags:
  - platform
type: feat
complexity: M
area: platform
created: '2026-07-27T22:59:24.484Z'
---
**Closed as NOT REPRODUCING.** The premise — an auto-escalated child grinding ~6 min 40 s before OOM — does not hold. The honest failure already lands in ~31 s, inside the §1 5–60 s budget, so there is nothing to calibrate. The heap ceiling stays at its 4096 MB default.

## What was measured

backoffice2 (6101 git-tracked `.ts/.tsx`, no `codemaster.config` → auto-escalated), cold, one-shot `node src/bin.ts op … --root …`, default child heap 4096 MB:

| op | result |
| --- | --- |
| `find_usages {name:'SubmitButton', file:'apps/emr/src/layouts/Form/components/SubmitButton/SubmitButton.tsx', role:'jsx', groupBy:'enclosing'}` — the exact repro | **31.3 s → `FAIL tool=oom`** |
| same shape, `Text @ apps/patient-care/src/components/Text/Text.tsx` | 33.5 s → `oom` |
| same shape, tiny fan-out, `BookingDoctorSelect @ apps/kalendarik/…` | 28.5 s → `oom` |
| `expand_type {name:'UserRole', file:'packages/common/entities/user/types.ts', line:24, col:14}` | 11.3 s → **OK** (also OK at 2048 MB and at 1024 MB) |

## Why ~6.6 min could not have happened

- **The tool's own telemetry contradicts it.** Across `~/.codemaster/usage/{fail,success}.jsonl` + `archive/*.jsonl`, no record of any op exceeds 47 s. This exact repro is recorded at 36122 ms (default 4 GB heap) and at 9103 / 6774 ms (a 1024 MB config sandbox under `/private/tmp/w1gate`). There are no `outcome:'crash'` / `'abandoned'` breadcrumb promotions, so no fatal call went unrecorded.
- **It is structurally unreachable through the daemon path.** `BRIDGE_REPLY_DEADLINE_MS = 150_000` (`src/bin.ts`) is the process host's `requestDeadlineMs`: at 150 s the parent SIGKILLs the child and every pending request settles as `tool=timeout`. A 400 s `tool=oom` cannot occur.
- The ~6.6 min was therefore a wall-clock impression by the observing agent — most plausibly several consecutive attempts read as one — not a measurement.

## The finding worth keeping

Cold cross-program `find_usages` on backoffice2 OOMs at 4 GB **regardless of the target** (31.3 / 33.5 / 28.5 s across three different symbols, including one with a tiny reference set). The cost is the multi-program build, not the size of the reference set — so a guard for this class must be repo-level, not per-target. Conversely `expand_type` (single program) answers in ~11 s and survives even a 1024 MB ceiling.

That kills lever A (a lower default child heap): the ceiling is shared by the whole child, so it would be paid by the ops that DO work on such a repo, in exchange for ~20 s on a path that fails either way.

The residual — refusing that fan-out class fast instead of after ~31 s — is a different claim and is tracked separately (see the process-mode fan-out guard task, which depends on t-396905 for the correct memory model).


**Superseded on the ceiling number by t-811950.** The fast-failure finding above stands (the honest
OOM lands in ~31 s, nothing to calibrate for latency). What no longer holds is "the heap ceiling stays
at its 4096 MB default": a fixed 4096 IS Node's own default limit on a 32 GB box (~4144 MB), so the
flag raises nothing, and the same call answers at a 5632 MB ceiling (~5.2 GB live heap). The ceiling is
now derived from the box (`src/daemon/heap-ceiling.ts`).
