---
id: t-004414
title: 'Semantic fan-out guard coverage gap: find_unused_i18n_keys / find_missing_i18n_keys are not gated at all'
status: backlog
priority: medium
tags:
  - dogfood
  - platform
type: bug
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-245013
  - t-820448
  - t-972931
surface:
  - ops
  - ops/guard
  - plugins/i18n
audience: both
evidence: unverified
created: '2026-07-27T23:42:33.636Z'
---
`src/ops/find-unused-i18n-keys.ts` and `src/ops/find-missing-i18n-keys.ts` carry NO
`semanticFanoutRefusal` call — they are the only ops of their profile outside the guard's coverage
(the other dead-code ops `find_unused_exports` / `find_unused_props` / `find_unused_scss_classes`
all guard at their `run()` entry).

Why it is a gap: both ops go to the `ts` plugin for usage sites (`t('…')` call sites across the
repo), i.e. the same warm-the-LS-and-fan profile the guard exists for. Under `isolation:'in-process'`
on an oversized repo an OOM there is uncatchable and kills the daemon (ARCHITECTURE §1/§9).

Honest scope — the risk is UNMEASURED, not low: the heavy ops covered by the W1 audit were measured
on backoffice2 (OOM of a 1 GB child in ~10 s), but the `i18n` plugin is INACTIVE there
(`DISPATCH unavailable`), so no measurement of these two exists on any oversized repo. Their cost
profile is unknown, not established as safe.

Not a decided fix: with spawn-time auto-escalation in place (t-754922) an oversized repo is normally
hosted in a killable child where the guard never fires, so "add the guard call" is one option among
several — the same conversation as the structural seam. Entry point, not a verdict.

Related: [[t-820448]] (the structural seam that would make coverage automatic rather than
call-site-by-call-site), [[t-972931]] (the mutating ops — rename / change_signature / move / extract
— are unguarded for the same reason).
