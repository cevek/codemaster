---
id: t-089408
title: The symbol question has no SALIENCE inside a grep-heavy workflow — a doc-sync track is ~95% legitimate grep, so the 5% that must not be grep arrives in the same shell rhythm and is never recognized
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: render
source: dogfood-jul
created: '2026-07-28T11:06:01.124Z'
---
The strongest self-report of three waves, from worker c850b51e — and the first one framed as a RECOGNITION
failure rather than a preference.

It did not "fall back to grep after a refusal". On three reference-graph questions it **never invoked
codemaster at all**, and got one of them wrong. Asked "which ops consume `searchCapFloor`", it grepped,
got 5 raw lines (2 of them imports), and generalized to a universal "READS disclose". That was the only
blocking defect of the track.

Verified after the fact: `find_usages {name:'searchCapFloor', groupBy:'enclosing'}` returns two consumers
AS DECLARATIONS (`run@find-definition.ts:35`, `usagesFloors@find-usages-view.ts:151`), `importsCollapsed=2`,
plus `complete=false` + `!! LOWER BOUND` naming 3 unloaded fixture tsconfigs.

**The asymmetry is the argument, and it is invisible unless you run both:** grep had the SAME
incompleteness and reported it with nothing. The tool was both more precise and honest about its limits;
the fallback was neither, and said so nowhere.

## Why it was not recognized — the mechanism, not the excuse

A doc-sync track is ~95% legitimate grep: verbatim doc text, header comments where rationale lives, prose
that symbol ops do not return at all. So the 5% that is a symbol question carries no salience — it arrives
in the same shell rhythm as the other 95% and reads as "just check one thing".

Note this repo ALREADY ships the obvious countermeasure: a `PostToolUse` hook on Bash that prints
"💡 use codemaster — it searches better than grep". It fires, it is correct, and it did not catch this
case — the agent had already formed and answered the question by the time the nudge printed, and the nudge
cannot tell a doc-text grep from a symbol grep, so it is noise 95% of the time and ignored by the 5th.

Directions worth weighing (none obviously right):
- make the nudge DISCRIMINATE — fire only when the pattern looks like an identifier (`\b[A-Z]\w+\b`,
  camelCase, a bare symbol name with no path/quotes), stay silent on prose greps. A signal that is right
  20× a day is ignored; one that is right twice a day is read.
- make it POST-HOC useful: when the grep pattern is an identifier, print what `find_usages` would have
  said (count + completeness), not an exhortation. Evidence beats advice.
- accept the recognition gap and close it downstream instead — see t-959904 (refusals name the working
  path) and t-034392 (the stale banner sends dogfooders to grep).

Related: t-933867 (the same agent-population failure, measured on a different track), t-631032 (the
codemaster-editing worker cannot use the MCP path at all).
