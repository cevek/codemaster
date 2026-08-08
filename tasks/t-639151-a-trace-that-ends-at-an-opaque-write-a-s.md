---
id: t-639151
title: A trace that ends at an opaque write (a store setter, a callback prop) reports the same shape as a trace that reached the end of the value's life — silence and completeness are indistinguishable
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
  - honesty
type: feat
complexity: M
area: trace
source: dogfood-inbox-aug
relates:
  - t-000041
  - t-647309
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:07:23.704Z'
---
The `trace_*` family is proof-carrying per hop, but a trace that stops because the value flowed somewhere it
cannot follow reports `found:N, truncated:false` — byte-identical to a trace that enumerated every reader.
The count then reads as an inventory when it is a floor, and the agent has no signal to go looking.

The exits that produce this: a store setter (`field.handleChange(next)`, a zustand `set`), a callback prop
typed `(v: T) => void`, a generic container's write method. Each is a point where the traced value leaves the
type graph the trace walks.

This is `t-647309`'s invariant (emptiness must carry HOW it was established) on the TRACE unit: the number is
true, and only its reading misleads. `t-000041` records a neighbouring instance for `trace_type_widening`
(only 4 relations traced, so a property-assign / spread / template flow is silently untraced) — same shape,
different missing edge.

## Ask (in the reporter's order of value)

1. **An honest boundary marker.** When a traced value flows into an opaque call, emit
   `boundary: field.handleChange @file:line:col` with `confidence: partial`, so the answer reads as "2 hops
   plus one exit I cannot follow" rather than "2 readers". The op is already proof-carrying elsewhere; this is
   the one place where silence and completeness look identical.
2. **The TanStack-Form edge, if a form plugin ever lands.** `field.handleChange(x)` /
   `form.state.values.<path>` is a resolvable pair: the field's `name` literal is usually a string literal at
   the same call site, and consumers read the same path off `form.state.values`. That turns a hand inventory
   into one call.

(1) is the honesty fix and stands alone; (2) is capability and is optional.

## Свидетельство (field report, 2026-08-05, /Users/cody/Dev/worktrees/amiro/forms-w2-date)

External agent, widening a shared date control's value type ("ISO date" → "ISO date OR the text the operator
typed"), needing every reader of that value before touching anything.

    trace_type_widening {file:'src/components/inputs/DatePickerField/DatePickerField.tsx', line:75}
    → widenings=0, found=2, truncated=false
      hops: boundValue → parseDate(value) → parseISO(argument)

Correct, and the whole answer — because the value's real consumers are reached through TanStack Form's store:
the control writes with `field.handleChange(next)` and eight payload builders read `value.dateOfBirth` inside
their own `onSubmit`. **14 real read sites, enumerated by hand.**

Reporter, explicitly: "Not a bug: nothing it said was wrong. The friction is that the shape of the answer does
not distinguish 'this value has two readers' from 'this value has two readers on my side of a wall'."
