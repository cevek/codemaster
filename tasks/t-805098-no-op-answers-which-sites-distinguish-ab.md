---
id: t-805098
title: No op answers "which sites distinguish ABSENT from PRESENT-BUT-EMPTY" on an optional field — the dangerous site is one where no branch exists at all, so there is nothing for a text search to find
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-288409
  - t-647309
  - t-731041
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:08:00.497Z'
---
Where an optional field encodes a permission or a scope, `undefined` and an empty collection mean OPPOSITE
things, and collapsing them is a silent failure in the unsafe direction. No op expresses the question.

Treat `T | undefined` whose `T` carries a collection or record member as a THREE-state type —
absent / present-empty / present-non-empty — and report, for each site that observes the field, which of the
three it distinguishes: all three, two, or none. **The "distinguishes none" list is the defect list.**

The sites to cover: `?.`, `??`, `== null`, `if (x)`, a destructure with a default, and — the one that matters
— the mapper-style collapse where `undefined` and an empty collection flow into one value with no branch at
all. That last shape is what no text search finds, because there is nothing to search FOR: the bug is the
ABSENCE of a branch, not a wrong branch.

## Why no existing op covers it

- `find_usages` gives every mention with no read of what the site DOES with absence.
- `construction_sites` answers who BUILDS the type, not who observes it missing.
- `trace_type_widening` is about a value's type broadening, not about a nullable's two empty states being
  conflated.
- `discrimination_sites` is the right SHAPE of answer for a different input — union-tag discrimination — which
  is exactly why an agent reaches for its name and then cannot use it.

## Свидетельство (field report, 2026-08-05, /Users/cody/Dev/worktrees/amiro/qa2-roster-vs-access)

`EmployeeDto.access` is `EmployeeAccessDto | undefined`. On the server, ABSENT means the staff member reaches
EVERY patient of the project; PRESENT-but-granting-nothing means they reach NONE. The frontend collapsed both
into one `{}` in a mapper (`accessGrantsFrom(employee.access?.clinics)`) and rendered the label belonging to
the second over the first — the screen said "No access" about someone who sees every patient record in the
workspace.

This class shows up wherever an optional field encodes a permission or a scope, and it fails silently and in
the unsafe direction.

## Note on provenance — this entry is a CORRECTION, and the correction is the useful part

The same reporter had earlier named `discrimination_sites` as something missing. They then checked it and
retracted:

    discrimination_sites {name:'EmployeeAccessDto'} →
      sites (0)
      notes: target type EmployeeAccessDto is not a union type — there is no discriminant to switch on;
      discrimination_sites answers "which switch/if-chains discriminate on a union T"

Their verdict: "That is a good answer — it refuses honestly and names its own remit instead of returning an
empty list I could have misread as 'no such sites exist'. No bug. The op does what it says." Recorded here
because it is a positive datum about the refusal doctrine (`t-259465`): a refusal that names its own remit let
an external agent self-correct without a maintainer round-trip. Nothing about `discrimination_sites` needs
changing.
