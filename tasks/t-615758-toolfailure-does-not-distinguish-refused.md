---
id: t-615758
title: '`ToolFailure` does not distinguish "refused BEFORE doing work" from "tried and died" — the escape sets differ, and conflating them printed the caller the exact call that had just crashed'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: correctness
source: dogfood-jul
created: '2026-07-28T13:18:38.756Z'
---
Filed by the worker that hit it while BUILDING the fix for t-959904 — the cleanest possible evidence,
since the defect reproduced inside the change meant to remove it.

Two failures wear the same shape today:
- **refused** — the op declined before doing any work (a guard fired on the ADDRESSING, e.g. a bare name
  is fan-capable);
- **died** — the op tried and the engine was killed (OOM / timeout).

Their escape sets are different, and the difference is not cosmetic. A file-pinned re-address escapes the
GUARD (which refused on addressing) but does nothing about a DEAD PROCESS. Conflating them produced a
refusal that printed the caller the exact call that had just crashed — because the code choosing the
alternative could not tell which of the two had happened.

The worker fixed it locally by splitting the trigger (`guard` vs `died`) inside the navigation table, and
filters program-building calls out of the `died` branch. That closes the instance. The CONTRACT is still
one shape: any future consumer of `ToolFailure` re-derives the distinction, or silently gets it wrong.

Generalizable lesson recorded with it, worth more than the instance:

> A static inference is valid only in the coordinate system its predicate came from. Carrying it to an
> adjacent path is measurement disguised as reasoning.

Here `isFanCapableTarget` is a property OF THE GUARD; applied to a path where no guard exists it says
nothing true. The live run caught it; static analysis did not.

Ask: make the distinction part of `ToolFailure` (a field, not prose), so "what can the caller do next" is
derivable rather than re-inferred per consumer. Related: t-959904 (the navigation table that consumes it),
t-544207 (the guard does not fire at all under auto-escalation, which is how the `died` path became the
common one).
