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

The urgent half (`list` crashes now) is handled as a STOPGAP: `semanticFanoutRefusal` added to
`list.ts`, `find_unused_exports.ts` and `find_unused_scss_classes.ts` (every op MEASURED heavy — see
below), nothing more. Priority dropped to medium accordingly, so the
urgent tag stops dragging a worker into the big refactor.

The structural half — the deny-by-default seam / `OpDefinition.warmsLs` registry — is HELD until
t-754922 (auto-escalation) lands. Reason: once an oversized repo runs in a killable child, the guard's
job changes from "prevent a daemon-killing crash" to "prevent memory bloat" (its original t-333163
framing). Designing the seam now means fixing semantics that are about to be inverted, and hands two
tracks the same shared contract. Land escalation, THEN decide whether the seam guard is still worth it
and at what altitude.

The "which ops actually warm" sub-question — the unguarded-op list above was derived from
`grep -c semanticFanoutRefusal`, which shows who LACKS the guard, not who WARMS the checker — is
answered empirically in the next section. Its measurements supersede the risk ordering above wherever
the two disagree.

## Measured, not assumed: which of the unguarded ops ACTUALLY force a heavy program build

Method (empirical, backoffice2 ~6.1k source files): `daemon.isolation:'process'` +
`daemon.maxOldSpaceMB: 1024` in a throwaway config, then each op via the CLI one-shot. An OOM of the
1 GB child is the discriminator "this op builds/warms the heavy program"; a normal answer means it did
not. (1024 MB clears child startup — `status` succeeds at that ceiling — so a death is the op's, not
the handshake's.)

OOMs the 1 GB engine (heavy — needs the guard):

- `list {registry:'components', pathInclude:[…]}` — ~10 s to OOM. Confirms the repro's class: the
  react plugin enumerates components off the live checker; `pathInclude` filters AFTER, so a
  narrow-looking arg is not a cheap one.
- `find_unused_exports {}` — ~10 s to OOM. The "repo-wide fan-out" hypothesis HOLDS. The §5-L2
  primary-first short-circuit bounds the number of reference searches, not the program build that
  precedes them, so the OOM lands before the short-circuit can matter.
- `find_unused_scss_classes {}` — ~10 s to OOM. Same class (it asks the ts plugin for imports +
  member accesses repo-wide) — the scss-FACING but ts-BACKED case.

Answers normally at 1 GB (single-program-exact; do NOT guard on this evidence):

- `expand_type {name+file}` · `construction_sites {name+file}` · `discrimination_sites {name+file}` ·
  `source {names}`. Caveat: only the FILE-PINNED addressing was measured. A BARE-NAME target on these
  resolves through navto (the same fan `find_definition`'s addressing predicate guards), so the
  bare-name path is unmeasured, not proven cheap.
- `find_missing_i18n_keys` — unmeasurable here: the i18n plugin is not active on backoffice2
  (`DISPATCH unavailable`). Its risk is unknown, not low.

So the risk ordering in the section above is confirmed for the top three and NOT confirmed for the
tail — the tail's file-pinned paths measured cheap.

## Stopgap landed (does not close this task)

`list`, `find_unused_exports` and `find_unused_scss_classes` — the three ops measured heavy — now call
`semanticFanoutRefusal` (the per-op sprinkle this task calls
out as the failing pattern), with the stated lifetime written at each call site. `list`'s call is
gated on the RESOLVED registry owner being ts or ts-dependent, so a cheap non-ts registry (scss)
is not falsely refused; the other two are unconditional (their `requires` already names ts). Still
open here: the bare-name paths of the tail ops, `find_missing_i18n_keys`, and above all the STRUCTURAL
seam — which is deliberately on hold until the auto-escalate-to-process-mode work settles what the
guard should mean.

## The guard's premise is now empirically verified (was an unverified §9/§19 claim)

The refusal message promises "process-mode survives the OOM as an honest failure, daemon stays up".
Checked live over a real MCP bridge on backoffice2 (own `CODEMASTER_SOCK_DIR`, `isolation:'process'`,
`maxOldSpaceMB: 1024`): the heavy op returns
`FAIL tool=oom — isolated engine process ran out of memory (code=null signal=SIGABRT) — fall back`,
the daemon survives (same pid answers the next call), the engine respawns, and a repeat of the heavy
op reproduces the same honest failure. No `Connection closed`. So the redirect the guard prints is
true advice, not a hope. Residual honesty note: the `oom` CATEGORY is a SIGABRT/code-134 heuristic
(`process-host.ts` `isOom`) — on a platform with another V8 abort signature it degrades to
`engine-process`/`crash` (still a structural ToolFailure, still a live daemon, just no oom hint).

## Stopgap widened

`find_unused_scss_classes` is now guarded too (the third measured-heavy op). It is the scss-FACING but
ts-BACKED case: `requires: ['ts','scss']` and the class-reachability join reads TS-side imports +
member accesses through the ts plugin, so it warms the checker over the whole program. The ts plugin is
always active here, so the call needs no ownership predicate (unlike `list`).

Still open in this task: the bare-name paths of `expand_type` / `source` / `construction_sites` /
`discrimination_sites` (unmeasured, not proven cheap), `find_missing_i18n_keys` (unmeasurable on the
dogfood repo — i18n inactive; risk unknown), and the STRUCTURAL warm-LS seam, which stays on hold until
the auto-escalate-to-process-mode work settles what the guard should mean.
