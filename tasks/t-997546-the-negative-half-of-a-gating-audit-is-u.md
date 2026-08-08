---
id: t-997546
title: 'The negative half of a gating audit is unexpressible: find_usages takes exact names only (no symbol FAMILY) and has no predicate on the site''s ENVIRONMENT ("what else does this enclosing declaration call")'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-127800
  - t-933867
audience: external
evidence: reported
created: '2026-08-08T12:05:02.358Z'
---
## What is missing

The documented anti-join covers "which member of a family does NOT call F". A whole class of audits needs
the two halves it cannot express:

1. **A symbol FAMILY as the query.** `find_usages` accepts exact names (or `symbols[]` up to 20). A family
   defined by a naming convention — `use(Create|Update|Delete|Patch|Transition)*` — is not expressible, and
   real repos hold an order of magnitude more such hooks than the array admits. Wanted: a glob/pattern in
   `name`.
2. **A predicate on the site's ENVIRONMENT.** `conditions:true` gives the condition chain AROUND a site; it
   does not answer "what ELSE is called in this same enclosing declaration". Wanted:
   `{enclosingCalls: {without: ['usePermissions']}}`.

Together they turn "which components call a mutation hook of this family and do NOT call `usePermissions`"
into one query. Separately, neither half is enough: the positive side already works well, and the negative
side is the one that decides scope.

The class is not permissions-specific: "every mutation fired without a `confirm()`", "every `useQuery`
without `enabled` beside a dependent parameter", "every component with a form but without `useAppForm`".
These are exactly the audits agents come to codemaster for instead of grep.

## Свидетельство

2026-08-03, `amiro/qa-authz-gating`. The question of the day — "which places render a control whose mutation
reaches `api.X`, while their component contains no `usePermissions()` call" — decided the scope of a whole
track.

- `find_usages {name:'usePermissions', groupBy:'enclosing'}` worked exactly as advertised: 69 enclosers, the
  positive side done in one call.
- The negative side could not be expressed. `batch + sql` is the right shape in principle, but both tables
  come from `find_usages`, and the needed set is not "files without `usePermissions`" (trivial) but "files
  with a call from the mutation-hook FAMILY and without `usePermissions`" — and the family is a name
  pattern.
- Fallback: `grep -rlE "use(Create|Update|...)"` filtered by absence of the string `usePermissions`. Result
  was junk — `src/components/ui/switch.tsx`, `DatePickerPopover.tsx`, `select.tsx` and other substring false
  positives — and the real instances had to be separated by reading. The inventory was then handed to a
  subagent that spent ~140k tokens on what is structurally ONE query.

This was the single place in that day's work where the agent had to step away from the tool.
