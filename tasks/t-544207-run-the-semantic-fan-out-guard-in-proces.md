---
id: t-544207
title: Run the semantic fan-out guard in process-mode too (force-overridable), so an oversized repo gets a fast honest refusal instead of a ~31 s OOM
status: backlog
priority: medium
parent: t-031282
depends_on:
  - t-396905
tags:
  - dogfood
  - platform
type: imp
complexity: S
area: platform
relates:
  - t-187018
  - t-254076
  - t-735577
  - t-820448
  - t-847874
  - t-980509
surface:
  - ops/guard
audience: both
evidence: measured
created: '2026-07-28T06:49:38.243Z'
---
`ops/guard/semantic-fanout-guard.ts` returns early unless `ctx.daemon.isolation === 'in-process'`, so an auto-escalated workspace never sees it. There, a heavy fan-out runs to completion — and on a repo whose fan-out does not fit, "completion" is an OOM at ~31 s. The failure is honest and the daemon survives (t-754922 did its job); what is missing is that the same verdict was knowable before the warm.

The guard's original frame (t-333163) was anti-memory-bloat, not anti-crash. Under process isolation `force:true` is genuinely safe — the child absorbs the OOM — so a refusal there is an advisory with a working escape, not a dead end. That is the one place `force` should override it (in-process must keep refusing `force`, per t-693742: forcing there kills the daemon).

## Blocked on the memory model, not on the wiring

**Do not wire this onto `estimateSourceFileCount`.** Gating on the git source surface (`> ts.searchWarmMaxFiles`, 4000) refuses every guarded fan-out op on any repo past 4000 files, including the ones whose fan-out fits — trading capability for tidiness, which is the mistake the guard already made once.

**And `estimateSearchPeak()` as it stands cannot serve this**, even though it is already on `TsPluginApi` and reachable from the guard with no new plugin API. Measured on backoffice2:

```
estimateSourceFileCount     6101
estimateSearchPeak          { peakFiles: 6103, pruned: true }
programs 26,  Σ fileNames   18299
```

`estimateSearchPeak` answers "what navto builds AFTER the discovery prune". backoffice2 is a loose-root monorepo, so it prunes to the primary (6103) — under the 9000 peak threshold. Confirmed end-to-end: `search_symbol {query:'SubmitButton'}` passes the peak guard and answers in 15.7 s on that repo. Wiring the fan-out guard to that number would refuse **nothing** on the very repo this targets.

The number a fan-out op needs is the **un-pruned Σ = 18299** (fan-out ops never prune — they span every program via `programsContaining`, each with its own checker). Exposing it is t-396905's work (a new un-pruned accessor in `plugins/ts`, or `estimateSearchPeak` returning both figures). Hence the dependency: land t-396905 first, then this is a small change to one file plus its message.

## Why the discriminator is repo-level, not per-target

Cold cross-program `find_usages` on backoffice2 at the default 4096 MB child heap, three different targets:

| target | |
| --- | --- |
| `SubmitButton @ apps/emr/src/layouts/Form/components/SubmitButton/SubmitButton.tsx` | 31.3 s → `oom` |
| `Text @ apps/patient-care/src/components/Text/Text.tsx` | 33.5 s → `oom` |
| `BookingDoctorSelect @ apps/kalendarik/src/containers/BookingDoctorSelect/BookingDoctorSelect.tsx` (tiny reference set) | 28.5 s → `oom` |

All three OOM, including the one with almost no references: the cost is the multi-program **build**, not the reference set. So a per-target guard would be the wrong shape — the property being gated belongs to the repo.

An older usage-log entry shows `Text` answering in 4157 ms while `SubmitButton` OOMs, which reads as a per-target discriminator. It is not: that call hit a **warm** LS. Cold, both OOM.

For contrast, single-program ops on the same repo are cheap and stay well inside the child heap — `expand_type {name:'UserRole', file:'packages/common/entities/user/types.ts', line:24, col:14}` answers in ~11 s at 4096, 2048 **and** 1024 MB. These are the ops that keep working on such a repo, and the reason the child's heap ceiling must not be lowered to force an earlier OOM (see t-973529).

## Cost to state when implementing

Whatever threshold is chosen, the band it cannot separate — repos above it whose fan-out would have fitted — pays one extra round-trip (`force:true`) rather than losing the capability. On the un-pruned Σ model that band is narrow; on the surface-count model it is not, which is why this waits.

## Definition of done

- Guard runs in both modes; in-process behaviour byte-identical (including `force` NOT overriding there).
- Process-mode message says what is true there: the child is killable, this op fans across every program, a repo this size exhausts the child heap (~30 s to fail), the cheap alternatives, and that `force:true` really retries.
- Oracle-backed behavioural test, not a constant check: the `test/e2e/auto-escalate.test.ts` harness (real git repo over threshold, live Orchestrator, real fork) with the discriminating pair — default → `size-guard` refusal with the ts plugin still COLD; `force:true` → a real answer. Note that the existing kill-on-deadline test in that file drives `find_usages` through the child and will need `force:true` to keep reaching the deadline path.
- `test/unit/semantic-fanout-guard.test.ts` currently pins the opposite ("process-mode NEVER refuses") — rewrite with the rationale.

## The measurement that changes this tasks framing (dogfood-jul, /Users/cody/Dev/backoffice2)

On a 6101-file repo the auto-escalation puts the engine in `process` mode, so this guard deliberately does
not fire — and the child then dies at Nodes DEFAULT ~4144 MB heap ceiling after 25–31 s inside the program
build (relayed fatal dump, three pids). So the choice today is between a fast honest refusal (this task) and
a slow honest refusal (the OOM). Neither answers the question.

That makes the ORDER matter: raising the escalated childs ceiling and adding a scoped/degraded answer path
come first, and this guard is the backstop for what remains genuinely too big — not the outcome we are aiming
for. Landing it alone would make the unanswerability instant instead of eventual.
