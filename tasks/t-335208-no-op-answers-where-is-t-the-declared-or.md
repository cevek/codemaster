---
id: t-335208
title: No op answers "where is T the DECLARED or CONTEXTUAL type of a literal" — the payload/config audit question, which assignability answers with hundreds of irrelevant sites
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-000140
  - t-228385
  - t-631139
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:01:32.250Z'
---
`construction_sites` answers a STRUCTURAL question: which object literals are assignable to T. The question
an audit over payloads / configs / options objects actually asks is an ANCHORED one: where is T the literal's
**written** type —

```ts
const x: T = { … };        // annotation
({ … }) satisfies T;       // satisfies
f({ … })                   // literal passed to a parameter typed T
function g(): T { return { … } }   // literal returned from a T-returning function
```

That set is small, exact, and **stable under all-optional fields**, because it is anchored on a written
annotation rather than on structural fit. The assignability set is neither: the types this class of audit
targets are all-optional by nature (every PATCH input DTO, every options bag), so `{}` satisfies them and
every literal in the repo qualifies.

There is no way to ask the anchored question today. `construction_sites` is the op an agent reaches for, and
it is the wrong tool by construction, not by tuning.

## Ask

A mode or a sibling op — `construction_sites {name, anchored:true}`, or `annotation_sites` — returning only
literals whose declared/contextual type is T, with the anchor kind per site (annotation / satisfies /
parameter / return). Assignability stays the default; the anchored set is the one an invariant audit can act
on.

## Why it is a capability gap and not ergonomics

The fallback in the field was a regex over source text with a hand-rolled ~25-line look-back to find the
anchor. That is precisely the silently-incomplete thing codemaster exists to replace: an aliased import, or a
helper that returns the payload, is invisible to it, and nothing in the output says so.

## Свидетельство (field report, 2026-08-05, /Users/cody/Dev/worktrees/amiro/forms-clear-policy)

Task: find every object literal BUILT AS a request payload, to audit the invariant "a payload key never holds
`undefined`".

- `construction_sites {name:'UpdateServiceItemInputDto'}` → 449 sites, OUTPUT CAPPED, dominated by
  `scripts/lib/openapi-codegen/*`, `src/local-api/handlers/*`, `src/lib/format-date.ts`.
- Expected shape of the real answer: ~15 sites.
- Reporter: "`pathInclude` does not help: the noise is not in a separable directory, it is in the definition
  of the question."

External agent, repo it does not maintain.

## Related

`t-000140` / `t-631139` are the two vacuity causes that make the assignability answer unusable here; this task
is the capability that makes de-noising unnecessary for the anchored question. `t-228385` is the adjacent gap
for literals with no NAMED type at all (cva / createElement / factory configs).
