---
id: t-980509
title: '`status` reports the isolation MODE but never the evidence, and costs an engine spawn to ask — no read-only "what would this repo get, and why" surface'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-000054
  - t-187018
  - t-233427
  - t-408918
  - t-474125
  - t-544207
surface:
  - daemon
  - mcp
  - ops/guard
audience: both
evidence: repro
created: '2026-07-28T08:27:26.318Z'
---
On a 6.1k-file repo the recurring question is "will this workspace run in-process or in a child, and on
what evidence" — it decides whether a heavy op is safe to attempt at all.

Today `status` prints `isolation=process` but not WHY. When the answer was surprising, the only way to get
the reason was enabling `CODEMASTER_DEBUG` and grepping the daemon log for one trace line.

The inputs already exist at spawn — the source count, the threshold it was compared against, and the
closed `IsolationReason` union (`core/isolation.ts`) that the refusal messages already consume. Surfacing
them is nearly free:
  `isolation=process (auto-escalated: 6107 files > 4000)`
  `isolation=in-process (within budget: 629 files)`
  `isolation=in-process (pinned by config)`

Second, smaller, and it compounds: `status` itself routes and SPAWNS. So on an unfamiliar oversized repo
the very first orienting call is also the first memory commitment — exactly backwards. A pure
"what would happen" mode (routing + size decision only, no engine) would make it safe to ask before
committing.

Related: t-187018 (no read-only path to the isolation guarantee at all).

## Same call should also say which GUARDS ARE ARMED — this is what makes the guard surface testable at all

From worker c989236e, which spent a whole track on guard refusals and reports that both behaviours it was
fixing are **unreachable from the surface they are written for**:

- the in-process fan-out guard never fires on a large repo, because auto-escalation (t-754922) puts the
  workspace in process mode and the guard's first line returns early — so its prose is dead code for the
  audience it addresses (this is also the evidence behind t-544207);
- the OOM path is only observable via a CLI one-shot.

So an agent cannot find out what will happen to it before it happens, and a worker cannot verify a guard
message without reconstructing the conditions by hand. That is why this track took five attempts to reach
the real message instead of one.

The ask is one line on the same call this task already proposes: alongside `isolation=… (why)`, state
which guards are ARMED for this workspace right now — isolation mode, and whether each threshold is
currently exceeded. Cheap: the numbers are computed at spawn and the thresholds are constants.

Its own summary: that one line would have turned the track on the FIRST call instead of the fifth.

## Why a read-only availability surface has an external consumer (dogfood-jul)

On /Users/cody/Dev/backoffice2 a PostToolUse hook appended "codemaster resolves this semantically — op:
find_usages / search_symbol / find_unused_scss_classes" to nearly every grep, ~8 times in one session, while
every one of those ops was refused on that repo before doing any work. The hook and the guard contradict each
other, and each nudge invites a call that will fail — which trains the reader to ignore the nudge.

The hook is not codemasters code, but it has no way to ask: there is no cheap, read-only "which ops can
actually answer on THIS repo, and why not the others" surface — `status` costs an engine spawn and reports the
isolation MODE without the evidence. Any orchestration layer (hook, wrapper, another agent) needs the same
answer, so this is the consumer that makes this task externally visible rather than a convenience.

## Field evidence: the ceiling had to be read with `ps`, and the oom failure could not say which wall was hit

Filed while measuring the escalated child's heap requirement on a 6.1k-file monorepo (t-811950) — every
question about codemaster's OWN runtime state had to be answered from outside the tool.

1. `status` reports plugins, ops and freshness, but not: whether this workspace is hosted `in-process` or in
   a `process` child, WHY (the `IsolationReason` the engine already carries), or what heap ceiling that child
   got. All three exist as structured values at spawn. Obtaining the ceiling required
   `ps -Ao command | grep serve-engine` → `node --max-old-space-size=8192 … daemon serve-engine`. A tool that
   can be asked about a repo cannot be asked about itself.
2. After `FAIL tool=oom — isolated engine process ran out of memory (code=null signal=SIGABRT)` the agent
   cannot distinguish "this repo needs more memory than the machine gives one child" (no remedy) from "more
   than the number in someone's config" (a one-line change). `code=134` carries neither. Partially closed by
   t-811950, which now cites the ceiling and its cause (`configured|box|cap|floor`) in the oom refusal — the
   `status` half remains open here.
