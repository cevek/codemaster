---
id: t-034392
title: 'The stale-daemon banner drives dogfooders to grep: it names only `daemon restart` (expensive, burns the warm LS) and never mentions that a CLI one-shot answers on current source in ~1.7 s'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-27T23:23:13.905Z'
---
Reported by worker 668b2fe3 against its OWN behaviour, which is what makes it load-bearing: it answered
the entire track with grep and only reached for codemaster at the end — on the repo whose whole point is
that agents should not grep.

Mechanism: editing codemaster's own `src/` makes the MCP path stale-by-construction (§3.6 self-staleness),
so every response carries `!! daemon code behind source — run codemaster daemon restart`. The banner is
honest but names only the EXPENSIVE remedy: a restart discards the warm LS the daemon exists to amortize.
It never mentions that `node src/bin.ts op <name> '<json>'` is a fresh one-shot reflecting current source
— measured at ~1.7 s, i.e. CHEAPER than the grep round the worker actually performed instead.

So the banner, as written, teaches the dogfooder to leave the tool. Fix is one clause in the banner text
naming the one-shot as the cheap in-place alternative. (CONTRIBUTING already documents the one-shot loop —
the banner is where an agent actually reads it, mid-task.)

Second, smaller item from the same report: on the codemaster repo itself, the three fixture tsconfigs
produce a permanent undiscovered-program floor, and it prints TWICE — once as a block and once verbatim as
a note — roughly 7 of ~20 lines of the response. A duplicated honesty signal trains the reader to skim past
`!!` markers, which is the opposite of what the marker is for. Dedupe to one occurrence.

Both are agent-surface defects, not cosmetics: they change whether the tool gets used at all.
