---
id: t-820448
title: "Guard audit t-411303 missed `list` (and the repo-wide dead-code ops): list{registry:'components'} OOM-kills the in-process daemon with NO size-guard message at all"
status: backlog
priority: medium
parent: t-031282
tags:
  - dogfood
  - multi-program
  - platform
type: bug
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-27T22:23:26.230Z'
---
## Repro (live, /Users/cody/Dev/backoffice2, ~6101 files, in-process; agent transcript 7237bc5c)

```
list { registry: "components", pathInclude: ["apps/emr/src/containers/FormController"] }
→ MCP error -32000: Connection closed
```

No `FAIL tool=size-guard`, no honest refusal — the daemon simply died. This was the FIRST daemon death
in that session; the later `find_usages` calls got their size-guard refusal from an already-respawned
daemon, and `force:true` then killed it a second time (t-693742).

`list` is worse than the force case, because the agent had no warning and no choice: a `pathInclude`d,
apparently-narrow registry query reads as cheap. It warms the LS through the react plugin all the same.

## Root cause — the audit was incomplete

t-411303 ("Audit remaining LS fan-out ops (member_usages / affected / trace_*)") is `done`, but `list`
was not in its scope. Current `semanticFanoutRefusal` callers:

  affected · find_definition · find_unused_props · find_usages · impact · impact_type_error ·
  importers_of · member_usages · trace_field_to_render · trace_invalidation ·
  trace_prop_through_tree · trace_type_widening

Unguarded and LS-warming (guard=0), by decreasing risk:

  list · find_unused_exports · find_unused_scss_classes · find_missing_i18n_keys ·
  construction_sites · discrimination_sites · expand_type · source

`find_unused_exports` in particular is a repo-wide reference fan-out by definition — the same OOM shape
as `find_usages`, unguarded. `expand_type`/`source` warm the checker but are single-target, so they are
lower risk (still worth measuring, not assuming).

## Fix

Do the audit properly and make the gap structural, not a checklist: the guard belongs at the seam where
an op first touches the warm-LS API, so a NEW op cannot ship unguarded by omission. Options — a guarded
wrapper on the `TsPluginApi` warm entry points, or a declared `OpDefinition.warmsLs: true` the dispatcher
enforces (a compile-error-by-exhaustiveness registry, mirroring the `FULL_DISPOSITION` pattern in §12).
A per-op sprinkle of `semanticFanoutRefusal` calls has now failed once and will fail again.

## Done

- `list` (and every op above confirmed to warm) either guarded or proven cheap by measurement.
- A test that fails when an op reaches the warm-LS seam without passing the guard.
- Note in ARCHITECTURE §9 listing the guarded set (present state) — pairs with t-140062.

## HOLD on the structural seam — do not pick this up as written

The urgent half (`list` crashes now) is being handled as a 2-line STOPGAP: `semanticFanoutRefusal` added
to `list.ts` and `find_unused_exports.ts`, nothing more. Priority dropped to medium accordingly, so the
urgent tag stops dragging a worker into the big refactor.

The structural half — the deny-by-default seam / `OpDefinition.warmsLs` registry — is HELD until
t-754922 (auto-escalation) lands. Reason: once an oversized repo runs in a killable child, the guard's
job changes from "prevent a daemon-killing crash" to "prevent memory bloat" (its original t-333163
framing). Designing the seam now means fixing semantics that are about to be inverted, and hands two
tracks the same shared contract. Land escalation, THEN decide whether the seam guard is still worth it
and at what altitude.

Open sub-question worth answering meanwhile, cheaply: the unguarded-op list in this task was derived
from `grep -c semanticFanoutRefusal`, which shows who LACKS the guard, not who actually WARMS the
checker. The claim that `expand_type` / `source` warm-but-are-lower-risk is unverified. The real set
must be derived from which `TsPluginApi` entry points force a program build — otherwise the audit
repeats exactly the omission that produced this bug.
