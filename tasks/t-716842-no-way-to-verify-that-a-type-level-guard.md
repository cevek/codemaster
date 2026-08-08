---
id: t-716842
title: 'No way to verify that a type-level guard FIRES: impact_type_error treats the intra-file diagnostic that IS the proof as a reason to distrust the answer, so proving a guard is not vacuous means editing the working tree by hand'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
surface:
  - ops
  - plugins/ts
audience: both
evidence: reported
created: '2026-08-08T12:06:57.701Z'
---
A type-level guard — a `satisfies` constraint, an exhaustiveness assertion, a discriminated-union check — has
one property worth verifying: that it actually fails when it should. A guard written so that it compares a
type with itself is VACUOUS, reads as correct, and is invisible to review; the only way to know is to break
the thing it guards and observe an error appear.

`impact_type_error` is mechanically the right op for that — it overlays a trial edit, reports baseline-diffed
REAL diagnostics, and writes nothing to disk — and it supports `{replace:'<new decl source>'}` on a
declaration span, which is what a catalogue/guard declaration is.

Its SEMANTICS are built for the opposite question. An error in the edited file itself sets `editSiteBroke` →
`downstreamTrusted:false`, and `brokenFiles` becomes a stated LOWER BOUND. For blast radius that is correct:
an edit-site error can collapse an inferred type and MASK downstream breaks. For guard verification it
inverts — the intra-file diagnostic IS the assertion and the whole answer, and the op reports it as grounds to
distrust the result. There is no way to ask "did the edited file itself go red, and with WHICH message?" as a
POSITIVE outcome.

## Ask

An `expectError:true` mode (or a distinct `verify_guard` op) where the edited file's OWN diagnostics are the
RESULT rather than a trust-invalidator: return the introduced intra-file messages verbatim and make the
verdict binary and readable —

    fires: true, message: "Type 'true' is not assignable to type '\"EDIT_ROLES_AND_ACCESS\"'"
    fires: false        // the vacuous-guard answer

Downstream attribution can be declared OUT OF SCOPE in that mode, which is honest and simpler than reporting
it as untrusted.

## Why it earns an op rather than a doc note

The fallback is an edit-run-restore cycle on the working tree: hand-edit the file, run `tsgo`, restore from a
copy, repeat on the rebased base. It writes to a tree reviewers may be reading, and in the field it destroyed
uncommitted work once (`git checkout` on a file that also held unstaged edits) — a risk the overlay approach
exists to eliminate.

The failure class is one this repo names in its own task schema (`kind: false-oracle` — a mock/doc/test
agreeing with itself and lying about reality, where a green gate proves nothing). A guard that checks nothing
is the purest instance. Making "prove it fires" one call instead of a cycle is what turns the check from
something an agent remembers to do into something routine.

## Свидетельство (field report, 2026-08-02, /Users/cody/Dev/worktrees/amiro/z-authz-simplify)

The reporter wrote an exhaustiveness guard whose first version was vacuous — the catalogue carried a type
ANNOTATION, which widened the derived keys back to the union, so the check compared the union with itself and
would have passed for an EMPTY catalogue. It read as correct. It was caught only by deleting a catalogue row
and noticing that no error appeared. **Two independent vacuous guards shipped in one session's diff** — one
written by the agent, one found by a reviewer.
