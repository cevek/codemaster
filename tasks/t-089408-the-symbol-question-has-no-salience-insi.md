---
id: t-089408
title: The symbol question has no SALIENCE inside a grep-heavy workflow — a doc-sync track is ~95% legitimate grep, so the 5% that must not be grep arrives in the same shell rhythm and is never recognized
status: backlog
priority: high
parent: t-826059
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: render
source: dogfood-jul
relates:
  - t-158109
  - t-233900
  - t-731041
  - t-815425
surface:
  - cli
  - docs
  - mcp
audience: both
evidence: measured
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

## The asymmetry, named from the position of having built the second front door (worker cdc7d789)

The two surfaces have now equalized in CAPABILITY (t-631032) and remain far apart in DISCOVERABILITY —
and the gap is mirror-shaped:

- **MCP** pushes every op's `inputSchema` into the tool list every session, so the catalogue is STANDING
  context the agent cannot avoid seeing. But it is stale-by-construction for anyone editing the tool.
- **CLI** is always fresh, but the catalogue must be PULLED (`status --op <name>`), and nothing surfaces
  at the moment a question forms. The worker wrote `find_usages {name, role, filter:{pathInclude}}` by
  copy-pasting from a task body — not from the tool.

So the population editing the tool gets **fresh + blind**; the external population gets **stale +
discoverable**. Neither gets both, and each is missing the half that matters for its own failure mode.

Its judgement, which reorders this against t-631032: **discoverability is the bigger half.** Composition
is what you reach for already knowing it exists; discoverability is what makes you reach at all. A worker
who does not remember the op never notices that it does not compose.

Concrete direction this suggests for the CLI side: the catalogue must PUSH, not wait to be pulled — e.g.
surface the two or three ops relevant to what just failed / just ran, at the moment of the call, rather
than requiring a separate `status` round-trip that an agent mid-task will not spend.

## Two refinements that change what "fix" means here (worker a42c3d8e, second doc track)

**1. Most of the pattern is NOT a missed opportunity — 4 of 5 question types genuinely do not belong to
the tool.** "Does this folder exist" is `ls`; "what does this module header say" is reading a file; "does
this sentence appear in the prose" is grep. Notably `ls` is what caught an omission in the worker's OWN
enumeration of `support/` — the right tool won on its merits.

So the honest denominator is much smaller than "every question a doc track asks". Optimizing as if agents
were skipping the tool constantly will over-fire and make the nudge noise (the very failure recorded
above). Exactly ONE question in the track was codemaster-shaped: "which surfaces render `navigationFor`".

**2. Why even that one went to grep — an economic reason, not a quality one.** It rode along inside a bash
call the worker was already making for `ls`. Marginal cost ≈ zero, versus a separate MCP round-trip for the
tool. Nothing about the answer's quality entered the decision.

That reframes the target: the competitor is not "grep's output" but "a call I am making anyway". A tool
invocation that costs a dedicated round-trip loses to a free rider even when it is strictly better — which
is also why t-631032 (composition on the one-shot CLI) did not change behaviour.

**3. Structural point about this whole class:** doc-sync is verified by PARAGRAPH, not by declaration, so
after any location-shaped answer the file gets opened anyway. The class is reading by construction — the
same shape as the "location is not the edit" finding recorded in t-631032, arriving independently from a
different track.

**4. Timing correction to the nudge direction proposed above.** The hook fires AFTER the bash call, when
the answer is already on screen — post-hoc by construction, so it cannot redirect the question it is
about. If a nudge is to work it must intercept the grep whose pattern is a BARE IDENTIFIER, before or
instead of the call, not comment on it afterwards.

## The same recognition failure with a DIFFERENT cause: the oracle lives outside the tool's perimeter (dogfood-inbox-aug)

Three external field reports, 2026-08-03..08-05, repos amiro / amiro-frontend (contract oracle = a sibling
java repo `../control-plane`, plus `openapi.json` and a markdown spec repo). Ops used per shift: 0. In each
case the reporter's own diagnosis is recognition, not preference — and the mechanism is a variant this task
does not yet name.

**The variant: momentum across a perimeter boundary.** Here the 95% is not legitimate-grep-on-prose, it is
legitimate-grep-on-code-we-do-not-index. Once the agent is in grep mode for the java repo / the spec json, it
stays in grep mode for the TS repo out of momentum, and the codemaster-shaped residue rides along. Quotes:

- «Steps 1-3 carry the entire verdict, and none of them is a TS symbol question, so I never opened codemaster
  for them … once I am in grep mode for the Java repo, I stay in grep mode for the TS repo too, out of
  momentum. That is a real cost — I nearly missed that `accessGrantsFrom` collapses `undefined` and `[]`
  into one value, which IS a codemaster-shaped question.» (2026-08-05)
- «промах не в том, что инструмент чего-то не умеет, а в том, что момент, когда он нужен, наступает внутри
  задачи, где он в остальном бесполезен, — и поэтому пропускается.» That track deleted an exported type and
  changed the semantics of the function reading it, and proved "no producer sends a bare value" with grep over
  two identifiers — «ровно тем способом, который молча пропускает алиас и ре-экспорт». What saved it was an
  independent reviewer re-asking the same question, not the tool. (2026-08-03)
- «За смену я не вызвал ни одного опа, и честная причина — не "забыл", а "оракул жил не здесь".» The place the
  tool stayed silent and review found the defect: a second consumer of a changed field semantic
  (`bi-reports.ts`) — «ровно тот класс, который символьный обход обязан находить». (2026-08-03)

Consequence for the fix direction argued above: an identifier-discriminating nudge does not reach this
variant, because the greps that build the momentum are in ANOTHER repo (or over a json spec), where any nudge
is correctly silent. What these reports ask for instead is a legible perimeter EDGE — see t-731041 (mark a
type whose producer is outside the index; state in the op-map that codemaster answers what the code does, not
what the server does). t-233900 is the temporal cousin: a whole track's questions were about revisions, which
no op is addressed by, so it ran on `git log -S`.
