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
relates:
  - t-004414
  - t-048595
  - t-163532
  - t-396905
  - t-544207
  - t-735577
  - t-972931
surface:
  - ops
  - ops/guard
audience: both
evidence: measured
created: '2026-07-27T22:23:26.230Z'
---
## Repro (live, /Users/cody/Dev/backoffice2, ~6101 files, in-process; agent transcript 7237bc5c)

```
list { registry: "components", pathInclude: ["apps/emr/src/containers/FormController"] }
→ MCP error -32000: Connection closed
```

No `FAIL tool=size-guard`, no honest refusal — the daemon simply died. `list` is worse than a forced
warm, because the agent had no warning and no choice: a `pathInclude`d, apparently-narrow registry query
reads as cheap. It warms the LS through the react plugin all the same.

## Why the guard missed it — a per-op checklist, not a seam

`semanticFanoutRefusal` is wired call-site by call-site at each op's entry, so coverage is whatever the
last audit remembered. t-411303's audit did not include `list`. That omission-by-construction is what
this task is about; the crash was only its first symptom, and the pattern will fail again.

## Measured: which unguarded ops actually force a heavy program build

Method (backoffice2 ~6.1k source files): `daemon.isolation:'process'` + `daemon.maxOldSpaceMB: 1024` in
a throwaway config, then each op via the CLI one-shot. An OOM of the 1 GB child is the discriminator
"this op builds/warms the heavy program"; a normal answer means it did not. 1024 MB clears child startup
(`status` succeeds at that ceiling), so a death is the op's, not the handshake's.

Heavy — ~10 s to OOM the 1 GB engine:

- `list {registry:'components', pathInclude:[…]}` — the react plugin enumerates components off the live
  checker; `pathInclude` filters AFTER, so a narrow-looking arg is not a cheap one.
- `find_unused_exports {}` — a repo-wide reference fan-out by definition. The §5-L2 primary-first
  short-circuit bounds the number of reference searches, not the program build that precedes them, so
  the OOM lands before the short-circuit can matter.
- `find_unused_scss_classes {}` — the scss-FACING but ts-BACKED case: it asks the ts plugin for imports +
  member accesses repo-wide.

Answers normally at 1 GB — single-program-exact, do NOT guard on this evidence:

- `expand_type {name+file}` · `construction_sites {name+file}` · `discrimination_sites {name+file}` ·
  `source {names}`. Only the FILE-PINNED addressing was measured; a BARE-NAME target resolves through
  navto (the same fan `find_definition`'s addressing predicate guards), so the bare-name path is
  unmeasured, not proven cheap.
- `find_missing_i18n_keys` — unmeasurable here (the i18n plugin is inactive on backoffice2,
  `DISPATCH unavailable`). Its risk is unknown, not low.

## Stopgap in place

The three measured-heavy ops call `semanticFanoutRefusal` — the per-op sprinkle this task names as the
failing pattern — with the stated lifetime written at each call site. `list`'s call is gated on the
RESOLVED registry owner being ts or ts-dependent, so a cheap non-ts registry (scss) is not falsely
refused; the other two are unconditional (their `requires` already names ts).

Current caller set: `affected` · `find_definition` · `find_unused_exports` · `find_unused_props` ·
`find_unused_scss_classes` · `find_usages` · `impact` · `impact_type_error` · `importers_of` · `list` ·
`member_usages` · `trace_field_to_render` · `trace_invalidation` · `trace_prop_through_tree` ·
`trace_type_widening`.

## The structural seam is decidable now

Auto-escalation (t-754922) is in place, so an oversized repo is normally hosted in a killable child and
the guard's first line (`ctx.daemon?.isolation !== 'in-process'` → `undefined`) returns early there. That
settles the question the seam design was waiting on: in the common case the guard's job is its original
anti-memory-bloat framing (t-333163), not crash prevention, and the crash case narrows to a PINNED
in-process workspace — `autoEscalate:false`, an explicit `isolation`, a failed fork, or a size that could
not be measured ([[t-408918]]).

So the seam is worth designing at that altitude rather than dropped: the invariant to buy is that a NEW
op cannot ship unguarded by omission. Options — a guarded wrapper on the `TsPluginApi` warm entry points,
or a declared `OpDefinition.warmsLs: true` the dispatcher enforces (a compile-error-by-exhaustiveness
registry, mirroring the `FULL_DISPOSITION` pattern in §12).

## Done

- The seam exists, or the decision not to build it is written down with its reasoning.
- The bare-name paths of `expand_type` / `source` / `construction_sites` / `discrimination_sites`
  measured, and `find_missing_i18n_keys` measured on a repo where the i18n plugin is active
  ([[t-004414]]).
- A test that fails when an op reaches the warm-LS seam without passing the guard.
- ARCHITECTURE §9 lists the guarded set (present state) — pairs with t-140062.

## The guard's premise is empirically verified

The refusal promises "process-mode survives the OOM as an honest failure, daemon stays up". Checked live
over a real MCP bridge on backoffice2 (own `CODEMASTER_SOCK_DIR`, `isolation:'process'`,
`maxOldSpaceMB: 1024`): the heavy op returns
`FAIL tool=oom — isolated engine process ran out of memory (code=null signal=SIGABRT) — fall back`, the
daemon survives (same pid answers the next call), the engine respawns, and a repeat of the heavy op
reproduces the same honest failure. No `Connection closed`. So the redirect the guard prints is true
advice. Residual honesty note: the `oom` CATEGORY is a SIGABRT/code-134 heuristic (`process-host.ts`
`isOom`) — on a platform with another V8 abort signature it degrades to `engine-process`/`crash` (still a
structural ToolFailure, still a live daemon, just no oom hint). That heuristic is [[t-163532]].
