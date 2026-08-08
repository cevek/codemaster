---
id: t-757342
title: 'find_unused_props has no dual: props every call site still passes and the component body never reads (dead contract) — the compiler catches only the destructured spelling'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - react
type: feat
complexity: M
area: framework
source: dogfood-inbox-aug
relates:
  - t-342283
  - t-975367
audience: external
evidence: reported
created: '2026-08-08T12:01:56.888Z'
---
`find_unused_props` answers one direction — declared props that NO JSX call site passes. The dual is
missing: props that call sites DO pass and the component body never READS. That is the dead-contract
direction, and it is the more misleading of the two — the callee stopped consuming the prop, every caller
keeps shipping it, and the next reader takes its presence as evidence the behaviour still exists.

The compiler is not a substitute. TS6133 on an unused destructured binding fires only for a component that
DESTRUCTURES. One reading `props.mode`, forwarding `{...rest}`, or giving the prop a default keeps compiling
silently, so a dead contract of exactly this shape ships with a green gate. Answering it needs the checker on
both ends — the declared member set on one side, member READS inside the component's own body on the other —
which is what `member_usages` already does for a type's member but cannot be scoped to one component body.

Shape: `find_unused_props {component, direction:'unread'}`, or an `unread` column on the existing rows so one
call separates never-passed (delete the declaration) from passed-but-unread (delete the declaration AND the
call sites). Repo-wide it is the same class as `find_unused_exports` — "which props does this codebase still
pass that nobody consumes" — and today cannot be asked at all.

Honesty constraint, from the report: a body that spreads its props into a child, or passes `props` wholesale
to a hook, makes the READ set unreadable; every candidate must demote to `partial` rather than claim
`certain`-unread. This is the same body-reachability analysis t-975367 needs for the forward direction.

## Свидетельство

2026-08-05, external agent, amiro worktree `forms-booking-conflicts`. Deleting a static block from
`BookFormFields.tsx` left `mode: BookFormMode` declared and passed by its single call site
(`BookFormBody.tsx:290`) with nothing in the body reading it. No query surfaced it before or after the edit;
it was caught incidentally by tsgo TS6133 on the now-unused destructured binding — from the compiler, after
the fact, and only because that component happened to destructure.
