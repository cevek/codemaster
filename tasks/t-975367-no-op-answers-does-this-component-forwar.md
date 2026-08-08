---
id: t-975367
title: No op answers "does this component forward prop P or swallow it" — a prop accepted by JSX/TS and dropped at an exhaustive destructure is invisible, and made a story assert a state it never rendered
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - react
type: feat
complexity: L
area: framework
source: dogfood-inbox-aug
relates:
  - t-575194
audience: external
evidence: reported
created: '2026-08-08T12:01:39.088Z'
---
Every existing prop op stops at the component's DECLARATION boundary. `find_unused_props` answers "declared
and no call site passes it"; `find_usages {props:{…}}` answers "which call site passes it". Neither looks
INSIDE the body, so the question that decides whether a props-driven contract actually holds — does prop P
reach a DOM element, or is it destructured and dropped — has no answer.

Both directions of the class are silent by construction:

- **Swallowed.** A component that destructures its props exhaustively with NO rest spread drops anything not
  named. TypeScript never objects for a hyphenated JSX attribute (`aria-*`, `data-*`), and for a declared
  prop the drop is not an error either. The caller believes the contract; the DOM never sees the value.
- **Overwritten.** A component that pulls a prop out deliberately and substitutes its own computed value —
  same class, opposite direction, equally invisible until measured in a browser.

Wanted shape: `prop_reaches_dom {component, prop}` → `reached` / `dropped-at-destructure` /
`forwarded-via-rest` / `overwritten`, each with its span. It is a reachability question inside one function
body, which is squarely a checker job and squarely not a grep job. Same honesty rules as the other react ops
apply and bind harder here: a body that spreads props into a child, or hands `props` wholesale to a hook,
makes the forward set unreadable, and every verdict must demote to `partial` rather than claim a `certain`
drop.

Repo-wide it is also an audit worth running on its own — "which components declare a prop they never
forward" is what makes an accessibility or data-attribute contract mechanically checkable.

## Свидетельство

Two independent external reports, two amiro worktrees:

- **2026-08-04, `form-refusal-contract`** — showcase variants written as `&lt;SelectableCard type="radio"
  checked={false} onChange={() =&gt; {}} aria-invalid /&gt;`. `SelectableCard` destructures exhaustively with
  no rest spread, so `aria-invalid` never reached the rendered `&lt;label&gt;`: the story compiled, rendered two
  ordinary cards and claimed to show the errored state. Caught by a human reviewer; "nothing mechanical could
  have". Sibling case the same day: `src/components/ui/input.tsx` pulls `data-error` out of props and
  overwrites it with its own computed value.
- **2026-08-05, `forms-w2-booking`** — auditing which controls fail to forward `aria-describedby`; recorded
  the gap as "declared-but-never-forwarded is invisible to every existing op", noting that ast-grep matches
  one syntactic shape but is not symbol-resolved, so an aliased or re-exported component escapes it.
