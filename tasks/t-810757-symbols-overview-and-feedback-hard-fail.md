---
id: t-810757
title: '`symbols_overview` and `feedback` hard-FAIL in a non-git / non-TS workspace — the two ops that exist to answer "what is here" and "this doesn''t work for me" are the ones that structurally cannot'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-28T08:23:46.799Z'
---
Three inbox reports from different sessions, none previously converted to backlog (manager's own gap —
tasks were being filed from worker summaries rather than from the inbox itself).

**1. `symbols_overview` dies in a non-git directory** — `FAIL tool=git` / "fatal: not a git repository"
(reported twice, 2026-07-27 19:11 and 19:51). This is the op documented as the OOM-safe first-contact
browse: the thing an agent is told to reach for when it does not know the repo yet, and the redirect
target of the size-guard's own refusal message. It rides the §10 git source surface
(`ls-source-files.ts`), so a workspace without git has no surface and the op throws instead of degrading.
There is already a documented non-git fallback for the freshness path (the bounded stat-walk, §3.5/§19) —
the discovery surface should degrade the same way, or refuse with an honest capability statement, never a
raw `tool=git` failure.

**2. `feedback` is gated behind TS-workspace resolution** (2026-07-27 18:32) — so a repo codemaster does
not support *structurally cannot report that it is unsupported*. The escape hatch for "this tool does not
work here" is itself behind the door it is meant to open, which means the exact population whose
experience we most need to hear is the one that cannot tell us. `feedback` writes to a global inbox and
needs no plugin, no program, no LS — it should resolve before workspace resolution, or fall back to a
root-less record carrying whatever context it does have.

Both are the same shape: an op whose PURPOSE is to work when the normal path does not, failing through
the normal path's own precondition.

Related: t-324342 (non-git freshness degradation), t-408918 (unmeasurable size), and the earlier inbox
wish for JVM/non-TS repos — a non-TS repo today gets neither an answer nor a channel to say so.
