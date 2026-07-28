---
id: t-034392
title: 'The stale-daemon banner drives dogfooders to grep: it names only `daemon restart` (expensive, burns the warm LS) and never mentions that a CLI one-shot answers on current source in ~1.7 s'
status: backlog
priority: urgent
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

## Second independent confirmation, with the sharper framing: the banner is honest, the ECONOMICS break

Worker 5c85b7ec (prop-aware JSX track) made ZERO navigational calls for the same reason, and named it more
precisely than the first report:

> ломается не правда, а экономика: для воркера, который правит САМ codemaster, это вся сессия, а не край.

The banner is correct on every response. But for someone editing `src/` continuously, a `daemon restart`
is required per QUESTION — versus a grep that is already typed. So the honest signal keeps firing while
the honest remedy keeps losing on cost, all session long.

Concrete instance of what that cost: the one question of that track that was squarely codemaster's —
"who consumes `jsxCallSites`", asked because the worker was about to change that seam and the react
plugin's unused-props model turned out to depend on it — went to grep. `find_usages {name:'jsxCallSites'}`
would have been STRICTLY better: the seam is re-exported through `plugins/ts/plugin.ts`, i.e. exactly the
alias form grep loses.

Raising to urgent: two independent workers, both editing the tool, both losing the one question that
mattered, both for a reason the fix is one line of banner text away from removing.

The fix as both reporters state it: add a second line naming the CLI one-shot
(`node src/bin.ts op <name> '<args>'`) as the fresh-by-construction path. It already exists and is always
current — but it is not in the tool list, so nothing makes an agent reach for it at the moment the banner
appears. Pair with t-631032 (the CLI now carries composition too, so the redirect is no longer to a
reduced surface).
