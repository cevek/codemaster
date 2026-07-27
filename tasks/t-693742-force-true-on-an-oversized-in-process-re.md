---
id: t-693742
title: 'force:true on an oversized in-process repo is a loaded gun: find_usages OOM-kills the singleton daemon (agent sees only "MCP error -32000: Connection closed") — route the forced op through a killable child instead'
status: done
priority: urgent
parent: t-031282
tags:
  - dogfood
  - multi-program
  - platform
type: bug
complexity: L
area: platform
source: dogfood-jul
created: '2026-07-27T22:21:33.638Z'
---
## Repro (live, on /Users/cody/Dev/backoffice2, ~6101 source files, default isolation:'in-process')

```
find_usages {
  symbols: ["ts:SaveButton@apps/emr/src/layouts/Form/components/SaveButton/SaveButton.tsx:14:14",
            "ts:SubmitButton@apps/emr/src/layouts/Form/components/SubmitButton/SubmitButton.tsx:13:14"],
  role: "jsx", groupBy: "enclosing", force: true }
```
→ `MCP error -32000: Connection closed`. The daemon is gone; every OTHER warm workspace on the
singleton dies with it.

## Why this is a §1 violation, not "the user asked for it"

`semantic-fanout-guard.ts:30` — `if (force === true) return undefined;` — hands the caller the exact
uncatchable in-process OOM the guard was built (t-679091) to prevent. The refusal message even
advertises it: "or pass `force:true` to warm anyway". But `force` is the ONLY in-band escape the message
offers that does not require editing a codemaster.config the repo does not have — so an agent following
the tool's own guidance lands on the crash by design. §1: "an OOM is uncatchable in-process and kills the
singleton daemon"; the escape hatch must not re-open it.

Worse, the blast radius is process-global. The daemon is a machine-wide singleton (§2): one forced call
on backoffice2 discards every other repo's warm LS and drops every connected bridge.

## Fix

`force` must mean "do the expensive thing SAFELY", not "warm in-process anyway". On an oversized repo
under in-process isolation, a `force:true` op should run in a killable forked child — the t-000052
process-host mechanism already exists and already turns a child OOM into an honest
`ToolFailure{oom}` — i.e. per-call escalation to process-mode for exactly the calls the guard flagged.
That also makes t-754922 (transparent auto-escalation) a natural follow-on: the same seam, applied
without the flag.

Fallback if per-call escalation is out of scope: `force:true` under in-process on an over-threshold repo
should REFUSE with "force is unavailable in-process — it would kill the daemon; set
daemon.isolation:'process' first", never silently attempt the warm. An honest refusal beats a crash.

## Done

- Oracle-backed test: over-threshold repo + in-process + `force:true` → either an honest result from a
  child, or a `ToolFailure`; in NO case a dead orchestrator.
- The refusal message stops advertising `force:true` as an in-process escape.
- ARCHITECTURE §9 rewritten to present state (see t-140062, same paragraph).
