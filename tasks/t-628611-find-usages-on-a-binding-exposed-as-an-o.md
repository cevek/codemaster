---
id: t-628611
title: find_usages on a binding exposed as an object property (&lt;form.Input&gt;) reports total=2 as complete while 51 JSX call sites exist — the reference graph stops at the registration site with no partial marker
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - honesty
  - react
type: bug
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-000036
audience: external
evidence: reported
created: '2026-08-08T12:00:43.528Z'
---
A component handed out as a PROPERTY of an object returned by a hook — `const form = useAppForm(); …
&lt;form.Input/&gt;` — is not reachable from its declaration. `find_usages {name:'BoundInput'}` returns the
declaration plus one `read` at the object literal that registers it, and reports that as a complete
`total=2`, while the JSX member-expression call sites are the real usage set.

Two separable pieces of work; a reader must not take this as one indivisible chunk:

**Minimum, and non-negotiable (§3.4 honesty).** The answer must not read as complete. A binding whose value
flows into an object literal / a returned object and is then addressed as a member is a place where the
reference graph provably stops, and that stop is detectable without following it. It must surface as
`partial` + "member-expression call sites not followed", so the count is read as a floor. The wrong part is
not the miss — it is that `total=2` is indistinguishable from a symbol that genuinely has two references.

**Full capability.** Resolve a JSX member expression through the type of its object, so a property whose
value is a known local function links to that function — at minimum for the tractable shape: a property
assigned a function IDENTIFIER in an object literal that the enclosing function returns.

Why this ranks above a normal miss: the tool's own routing guidance tells the agent that symbol-identity
questions go to codemaster because grep is silently incomplete. For this API shape the situation INVERTS —
`&lt;form.Input` is a literal that cannot be aliased, so grep is reliable and codemaster is the one that
under-reports, confidently. An agent following the instruction gets the worse answer.

Related but distinct: t-000036 (`jsxCallSites` mis-ATTRIBUTES `&lt;C.Sub/&gt;` attributes to `C`, affecting
find_unused_props). That one is about the attributes of a member-expression tag; this one is about the tag's
call sites being unreachable from the declaration at all.

## Свидетельство

2026-08-05, external agent, amiro worktree `forms-w2-a11y`. Every form field in that repo is a member of the
object returned by `useAppForm` (`BoundInput`, `BoundLabel`, … registered in one object literal at
`src/lib/form.tsx:1586`). 279 such JSX call sites across `src/`: `form.Input` 51, `form.Body` 41,
`form.Field` 35, `form.Submit` 29, `form.Label` 23. `find_usages {name:'BoundInput', groupBy:'enclosing'}`
→ `total=2` (the declaration at `form.tsx:916` + the registration read). Blast radius of a migration and the
per-binding call-site sets both had to be grepped. Reporter's note: "grep is reliable here and codemaster is
not, which inverts the repo's own routing guidance."
