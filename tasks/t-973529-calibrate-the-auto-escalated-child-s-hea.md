---
id: t-973529
title: Calibrate the auto-escalated child's heap ceiling — an oversized fan-out grinds ~6.6 min before OOM instead of failing fast
status: backlog
priority: urgent
parent: t-754922
tags:
  - platform
type: feat
complexity: M
area: platform
created: '2026-07-27T22:59:24.484Z'
---
Auto-escalation (t-754922) converts the crash: on backoffice2 (no codemaster.config, ~6.1k files) a file-pinned `find_usages {role:'jsx', groupBy:'enclosing'}` returns `FAIL tool=oom — isolated engine process ran out of memory (code=null signal=SIGABRT)` with the daemon alive. Measured live.

The residual is UX, not safety: an auto-escalated repo has no config, so the child inherits the DEFAULT heap (~4 GB) and grinds for ~6 min 40 s before the OOM. The honest pre-warm refusal it replaced answered in ~9 s. An agent now waits minutes for a failure it could have been told about immediately.

Measures to weigh (a calibration decision, deliberately left out of t-754922):
- give an AUTO-escalated child a lower default `--max-old-space-size` than the ~4 GB inherit, so it reaches memory sooner than a multi-minute grind;
- and/or keep a pre-warm advisory inside the escalated child — no longer a crash guard there, but a fast "this fan-out will not fit" answer.

Neither may re-introduce false refusal: a repo whose fan-out DOES fit must still answer.

## Measured anchor for the calibration

Two live data points on backoffice2 (~6.1k files), same repo, same file-pinned `find_usages {role:'jsx', groupBy:'enclosing'}`:

- child heap ~4 GB (the inherit an auto-escalated repo gets, no config): OOM at **~6 min 40 s**, `FAIL tool=oom … signal=SIGABRT`.
- child heap 1024 MB (explicitly configured, measured on the sibling gate experiment): OOM at **~9–10 s**, same structural failure.

So the cost curve between them is steep, and 1024 MB is a measured lower anchor that still produces the honest `oom` category rather than a deadline kill. What is NOT measured is the false-refusal side: a heap that low may also kill fan-outs that WOULD have fitted at 4 GB. The calibration therefore needs a repo whose fan-out succeeds, to find a ceiling that keeps success while cutting the grind — a middle value (e.g. 2048 MB) measured both ways, not 1024 adopted blind.
