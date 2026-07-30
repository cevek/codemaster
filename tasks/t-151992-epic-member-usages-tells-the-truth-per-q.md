---
id: t-151992
title: "EPIC: member_usages tells the truth per query and misleads as a whole — a member question's real footprint spans sibling types, index-signature-open types, and value objects"
status: backlog
priority: high
type: imp
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-100043
  - t-250147
  - t-278380
  - t-342283
  - t-560034
audience: external
evidence: measured
created: '2026-07-30T11:24:33.823Z'
---
## The class

`member_usages` resolves a member by IDENTITY, which is exactly right and exactly why its answers under-read
the question the caller actually asked ("everywhere this field is touched"). Three measured shapes, one root:

- the same domain field lives on **generated sibling types** (`Create*/Update*InputDto`), so a `complete=true`
  over the response type silently omits every request-body write site;
- the owning type is **index-signature-open** (`Record<string, unknown> & {…}`), where the op FAILs with
  "has no member X" — asserting an absence that is false, since every string key is structurally a member;
- the member lives on a **value/context object** rather than a declared type, where no dead-member question
  can be asked at all and the grep fallback can return a false "dead" through an aliased read.

Each is separately landable. They belong together because the fix for one changes what the others must say:
a list-valued target, a `partial` verdict for open types, and a value-object member surface are three answers
to one question about SCOPE — what counts as "this member".
