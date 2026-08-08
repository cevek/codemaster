---
id: t-045024
title: 'The React RENDER tree is not the reference graph: no op answers "what providers are above this callsite" or "is this component reachable from a route (vs only from a story)" — two independent reports, both fell back to hand-reading'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-100043
  - t-159797
  - t-849286
surface:
  - ops
  - plugins/react
audience: external
evidence: reported
created: '2026-07-28T16:10:25.779Z'
---
Two independent external reports, two amiro worktrees, same underlying gap: every existing op answers
questions about STATIC REFERENCES, while the question being asked is about the RUNTIME RENDER TREE.

**Facet A — provider ancestry** (`save-only-page-forms-guard`). A hook changed behaviour depending on
whether its callsite renders inside a popup provider (`DirtyGuardProvider`, mounted by Dialog/Sheet) or on
a bare page. Sizing the blast radius needs: "of the 32 `useAppForm` callsites, which render under a
Dialog/Sheet subtree and which under `AppLayout`?" `find_usages` gives the enclosing function;
`importers_of` gives module edges. Both are static-reference facts. Fell back to grep + hand-reading each
file and the route files — and notes it is exactly the silently-incomplete mode the repo warns about,
since the discriminating fact for one callsite lived in a different file entirely.

**Facet B — reachability and callsite ROLE** (`save-only-patient-record-fixes`, needed twice in one
track). "Is this component reachable from the live UI?" `find_usages` honestly returns enclosers, but a
story file ranks equally with a production callsite, so "the only consumer is a story" has to be inferred
by eye from filenames (`PatientCarePlans` → only `PatientCarePlans.story.tsx`). The second instance is
worse: `ProfileEditPanel` is rendered under a switch on a string mode that nobody ever assigns — dead for
a DATA-FLOW reason that a reference query cannot see at all.

Asks, in the reporters' words:
- **callsite role in results** (prod / story / test), so "used only in a story" reads out of the answer
  instead of being eyeballed;
- **reachability from routes** — is there a render path from an entry point to this component;
- **provider ancestry** — which context providers enclose a given callsite.

Why this is one task and not three: all three need the same missing thing — a render-tree model built
from JSX composition plus route entry points, rather than the reference graph. Whether it ships as one op
or several is a design question for whoever picks it up; splitting the FINDINGS would hide that they share
a foundation.

Honesty constraints any implementation must carry, from the reports themselves: a mode-switch branch is
data-flow, not composition — it must be flagged `dynamic`, never silently resolved; and role
classification must come from configuration/convention that the repo declares, not from filename guessing,
or the tool merely automates the eyeballing it replaces.

Related: t-159797 (callback exit paths — the other "static references cannot answer this" family),
t-849286 (react-query consumption shape).

## Свидетельство — три новых независимых внешних репорта (2026-08-05, три worktree amiro)

The same gap, now five independent reports. What these three add over facets A/B: the question is not only
"which providers are above this callsite" across files, but a STATIC CONTAINMENT PREDICATE over one
component's own JSX — and in this repo class it is the predicate the defects actually turn on.

- **`forms-silent-writes`** — a `<Dialog>`/`<Sheet>` mounts its `DirtyGuardProvider` inside its OWN returned
  JSX, so a component whose body calls a hook reading that context while its JSX renders the Dialog is ABOVE
  its own provider: the hook resolves the provider of whatever popup the component was rendered from, or
  `null`. `ReasonDialog` registered its form's draft probe with the surrounding `Sheet`, so typing a
  cancellation reason made a read-only detail panel prompt "Discard unsaved changes?" while the dialog's own
  guard heard nothing. Invisible to typecheck, lint, tests and knip; found by driving the browser. The agent
  built the right query shape — two `find_usages` (`role:'call'` for the hook, `role:'jsx'` for the popup) +
  an `sql` INNER JOIN on `encloser` — and it OVER-reports: the join cannot tell "the hook runs above this
  JSX" from "the hook runs in a sibling subtree the same component also renders". Fell back to a shell loop
  over grep; 10 candidates surfaced, 1 confirmed by hand. Asks: a `sameEnclosing` conjunction mode (or a
  documented `sql` recipe) so the join is first-class, AND a way to constrain the JSX fact to "rendered by
  THIS component's own return" so the answer means "the hook cannot see this provider".

- **`qa2-settlement-panel`** — a panel keeps a nested popup's `open` flag in its own `useState`, but the
  panel is emptied by its container rather than unmounted, so the flag outlives the record it was raised for
  and a destructive confirm prompt greets the operator on the NEXT record. The predicate deciding whether a
  given panel has the defect is purely structural: the flag is declared ABOVE `<SheetContent>` and the popup
  reading it is rendered as a SIBLING of `<SheetContent>` rather than inside it (SheetContent renders
  children without `forceMount`, so anything under it dies on close by construction). Asked for
  `jsx_ancestry {element, relativeTo}` → rows of `file:line · descendant|sibling|unrelated`, plus the
  composed half: where a hook's binding is declared relative to a JSX boundary. Swept eight files by hand;
  the first count was wrong in BOTH directions (1 false positive, 3 missed surfaces).

- **`qa2-confirmations`** — the same containment question stated as `renders_under {inner, outer}` with
  per-path evidence (each hop a `file:line` JSX site, a hop through a ternary / `children` prop / render prop
  flagged `partial`/`dynamic`). Names three further repo-wide rules it decides: which provider a
  `useAppForm`/`useDirtyGuard` call resolves, whether a query sits under a `<Suspense>` boundary that has a
  skeleton, and which Radix overlay a control is nested in. Two hops called out as where hand-tracing goes
  wrong and which an implementation must handle explicitly: (1) `children`/slot props —
  `<SheetContent>{body}</SheetContent>` where `body` is a variable built earlier in the same component;
  (2) a component that renders its own overlay, so its CALLER is above the provider while its own JSX is
  below it. Notes that even a floor-only answer ("at least one static path exists, here it is") replaces most
  of the manual tracing, and that the NEGATIVE answer is what proves the dangerous half of the predicate.

Priority raised medium→high→urgent is NOT claimed here: the failures are confidently-wrong-toward-INACTION
(missed surfaces, an over-reporting join the agent could discount), so this stays `high` with five reports
behind it. The related remount-identity question is t-425437.
