---
id: t-208047
title: 'The `!! CANNOT CLAIM` predicate is uncalibrated in BOTH directions: it stays silent on a name with 2 real declarations, and fires on every call over an unloaded tsconfig that cannot declare the name — so the marker stops being read exactly where it starts mattering'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
  - honesty
type: bug
complexity: M
area: correctness
source: dogfood-inbox-aug
relates:
  - t-071368
  - t-286255
  - t-316487
  - t-647309
surface:
  - format
  - ops
  - plugins/ts
audience: both
evidence: reported
created: '2026-08-08T12:04:32.202Z'
---
`target-is-the-only-symbol-of-this-name` is codemaster's load-bearing resolve-time disclosure (§3.4/§3.6): it
tells the reader that every count and every emptiness in the answer is about ONE of several possible symbols.
Its firing condition is not the CLAIM it states, but a proxy for it — the candidate page got cut, or an
unindexed nested tsconfig exists — and the proxy is wrong in both directions. These are not two defects; they
are one uncalibrated predicate, and they compound: the false positives train the reader to skip the line, and
the false negatives are then invisible in a channel nobody reads.

## The two conditions any fix must satisfy

1. **It FIRES when a name actually resolves to N>1 declarations**, even when nothing was truncated. Two
   declarations is the dangerous case *precisely because it does not look truncated*: the answer is clean, the
   page is complete, and the tool silently answered about one of them.
2. **It does NOT fire when the unloaded program cannot declare the name.** An unindexed tsconfig in a
   different package is not doubt about this target; stating it as doubt is a claim the evidence does not
   support, in the direction that costs the channel its meaning.

A cheap syntactic scan of an unloaded config's include globs answers (2) — the same class of scan
`symbols_overview` already runs with no program build.

## Why this outranks its size

The disclosure channel is the mechanism by which every other honesty guarantee reaches the agent. A channel
that fires on 100% of answers carries zero information about THIS answer, so a reader who calibrates on it
correctly learns to skip it — and then misses the one real ambiguity. A corrupted channel is worse than an
absent one: it also silences the future true positives it was built for.

## Свидетельство (field reports)

**Over-firing — 2026-08-07, `/Users/cody/Dev/backoffice2`** (external agent, pnpm monorepo, 12 apps).
Every op call in the session — search / source / find_usages / find_definition / construction_sites, all on
`kalendarik` symbols — appended:

    !! CANNOT CLAIM unsafe=target-is-the-only-symbol-of-this-name … 1 nested tsconfig(s) are NOT loaded
    as programs (apps/patient-care/tsconfig.test.json)

The unloaded config belongs to a DIFFERENT app than every symbol asked about, and is test-only; it cannot
plausibly redeclare `normalizeWebSocketBookingHistory` or `GatewayBookingSchemas`. Reporter: "By call ~8 I was
skipping the line entirely, which is exactly when a real ambiguity would slip past." The same session is the
source of `t-631139`, and the reporter flagged this independently there too — two mentions, one session.

**Under-firing — 2026-08-07, `/Users/cody/Dev/worktrees/amiro/sync-w0-api-foundation`** (external agent).
An OpenAPI generator emits `src/api/generated/hooks.ts`; hand-written hooks live in `src/api/hooks/`. Its
override scanner matches only the non-suspense base name, so a hand-written `useSuspenseFoo` with no `useFoo`
beside it does not suppress the generated twin: two exported functions, same name, different signatures,
different modules, both live. The compiler, the linter and dead-code analysis are all happy.
`find_usages {name:'useSuspenseClinicEmployees'}` picked ONE declaration and answered about it — clean-looking,
no marker, since only two declarations existed and nothing was truncated. "Every count in it was a floor and
nothing said so." The collision was found by grepping the generated file after a reviewer pointed at it.

Reporter's framing, which is the point of the task: "the failure mode is not 'I got a wrong answer' — it is
'I got a correct answer to a question I didn't know I was asking'."

## Second-order ask from the under-firing report

A first-class **`duplicate_exports`** gate — "every exported name in this repo is declared once" — usable as a
CI invariant. In a codegen repo the violation is silent by construction. `symbols_overview {duplicatesOnly}`
computes something close, but the reporter did not reach for it: it reads as a within-catalogue
disambiguation aid, and the place the warning was needed was the `find_usages` result, not a separate
catalogue call they had no reason to make. Whichever way that is resolved, condition (1) above is what makes
the warning arrive where the question is asked.

## Related

`t-286255` states the over-firing half as a render/UX problem (a channel that fires always carries no
information) and is the natural home for the once-per-session-header remedy. This task is the PREDICATE:
whoever fixes only the rendering leaves the false negatives, and whoever fixes only the false negatives makes
an already-ignored line louder. Coordinate — do not close one as the other.
