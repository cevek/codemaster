---
id: t-109741
title: No prop-aware JSX query — a wrapper-only sweep shipped an analysis claiming a 3-file surface when the real one was 11; the miss was caught by a screenshot, not by the tool
status: backlog
priority: urgent
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T08:27:07.973Z'
---
Real consequence, not a hypothetical: a design-system sweep (swap primary/secondary button styles across
every EMR form action row) shipped a wrong impact analysis.

The repo expresses "which style" two equivalent ways:
(a) named wrappers — `<BlueButton>` / `<LightBlueButton>`;
(b) the base component with an explicit prop — `<Button variant="contained">` / `<Button
variant="low-contrast">`.

The agent asked the (a) question (`find_usages role:'jsx'` on both wrappers), got size-guard-refused, fell
back to grep for `'<BlueButton'`/`'<LightBlueButton'`, and reported a 3-file change surface. Five more
forms used form (b) and were invisible to BOTH the wrapper query and the grep. The error surfaced only
when the app was run and an unchanged button appeared in a screenshot. Real surface: 11 files.

Note this is the failure mode codemaster exists to prevent — a silent miss that grep cannot see — and the
tool could not express the question either.

Wish, either shape:
  `find_usages {name:'Button', role:'jsx', props:{variant:['contained','low-contrast']}}`
or `jsx_prop_sites {component:'Button', prop:'variant'}` → sites grouped by literal value, plus explicit
`absent` and `dynamic` buckets (the dynamic bucket is load-bearing: a computed variant must be flagged,
never silently omitted, §3.3).

The syntactic JSX scan this needs already exists — `jsxCallSites` (per-attr value signal + `{...spread}`
flag) is what the react plugin's unused-props read-model rides on.

## Verified from the originating session transcript (backoffice2, session 7237bc5c)

The write-up above was the reporter's own summary. The call sequence confirms it and adds the causal
chain — this is evidence, not recollection:

```
source {BlueButton, LightBlueButton}                                  → ok
find_usages {symbols:[BlueButton, LightBlueButton],
             role:'jsx', groupBy:'enclosing'}                         → FAIL size-guard
Bash: grep -rn "<BlueButton" / "<LightBlueButton"                     → fallback
… later: grep -n "variant=|<Button", grep -rn "low-contrast"          → form (b) finally found
Edit VisitNoteForm / VisitNoteFormB2B / ConsiderationNoteFormB2B      → the five bypassing forms
playwright screenshot                                                 → the actual catch
second commit: "Five forms bypass the shared buttons"
```

Two findings this settles:

1. **It is a capability gap, not a steering one.** The agent DID ask codemaster the right question — the
   wrapper JSX query — on its first attempt. It could not ask the prop question at all, because no op
   expresses it. So better naming/steering would not have helped; the query does not exist.

2. **The size-guard refusal is UPSTREAM of the shipped bug, not adjacent to it.** The refusal pushed the
   agent onto grep, and grep can only match the literal `<BlueButton` — form (b) is structurally invisible
   to it. Had the wrapper query answered, the agent would still have missed form (b), but it would have
   been working from a semantic result rather than a textual one, and the `<Button variant=…>` sites were
   eventually found by a LATER grep for `variant=` — i.e. the information was reachable, just not from the
   path the refusal forced.

Reinforces t-959904 (a refusal that redirects to a strictly weaker tool is not a neutral event) and
t-544207 (the guard refuses repo-wide where the cost is repo-wide, so a narrow JSX query pays the full
fan-out price).

The session also wrote itself a memory note (`emr-button-style-duality.md`) recording that EMR expresses
button styling two structurally different ways — the agent learned by shipping the bug what a prop query
would have told it in one call.

## Second INDEPENDENT report, different repo, different agent, different framing — raising to urgent

`/Users/cody/Dev/worktrees/amiro/save-only-rule-to-docs`, 2026-07-28. Task: audit every call site of an
escape-hatch React prop (`dirtyGuard={false}` on Dialog/Sheet, `marksDirty={false}` on
Switch/Select/Checkbox) to replace an enumerated doc with a criterion.

**The doc claimed 7 sites. Reality was ~21, plus one dynamic `dirtyGuard={!isView}`.** So this gap has now
put a wrong count into a shipped artifact TWICE, in two repos, for two different reasons — the first was a
style sweep that shipped 3-of-11 (above), this one a doc that under-counted 7-of-21.

Why each existing op fails, per the reporter — useful because it maps the gap precisely:
- `find_usages {name:'dirtyGuard'}` — a JSX attribute is not a referenced symbol at the call site;
- `member_usages {member:'dirtyGuard'}` needs a TYPE target, but the props type is an inline literal on the
  component (`function Sheet({dirtyGuard = true, …})`), so there is no named type to address. Called with
  only `{member}` it fails `bad_args` — fair, but the workable form is not discoverable from the message
  (see t-959904: a refusal that does not name the working call);
- `find_unused_props` answers the INVERSE (props nobody passes), not "who passes it, and with what".

And the fallback is exactly the case the honesty contract warns about: the attribute is literal text, but
the COMPONENT it sits on can be aliased or re-exported, and value-side expressions (`{!isView}`,
`{someFlag}`) are invisible to a `={false}` text search. The reporter found the dynamic one only because it
happened to share the prop name in the same grep — i.e. by luck.

Requested shape, compatible with the one above:
`prop_usages {component:'Sheet', prop:'dirtyGuard', value?: 'false'|'any'}` — resolve JSX attribute sites
through the checker (so aliased imports count), classify the passed value as literal /
dynamic-expression / spread-opaque, and demote to `partial` on spread.

Note the recurring shape both reports share: **"audit every consumer of an escape-hatch / variant prop"**
arises whenever a codebase documents an opt-out or a design-system variant. Today the only honest answer
is grep plus manual reading of every hit to spot dynamic values — and both times the manual step is where
the count went wrong.
