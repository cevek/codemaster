---
id: t-973529
title: Calibrate the auto-escalated child's heap ceiling — an oversized fan-out grinds ~6.6 min before OOM instead of failing fast
status: backlog
priority: high
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
