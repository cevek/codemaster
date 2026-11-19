---
id: t-477634
title: 'Gate: run tsc/eslint/knip of fix-and-check/check inside cpu-slots-run'
status: backlog
priority: low
created_by_session: s-363919
author: mb-c5e4101d
created: '2026-11-19T08:00:49.164Z'
---
The `fix-and-check` and `check` scripts in `package.json` (tsc ×2, eslint, knip) take no CPU slot, so on a shared Linux host they load the CPU unseen by the test files queuing in slots beside them (cpu-slots README, "What it does not cover"). `cpu-slots-run [--max N] -- <cmd>` holds slots for a whole command. Open: which width each step gets (`eslint --concurrency @slots@`; tsc is single-threaded → one slot), and whether the added wait is worth it for a gate that runs in tens of seconds.
