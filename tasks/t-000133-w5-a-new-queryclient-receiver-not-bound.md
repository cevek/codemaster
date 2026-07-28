---
id: t-000133
title: W5-a — `new QueryClient()` receiver not bound
status: backlog
priority: low
type: feat
complexity: M
area: framework
relates:
  - t-000020
  - t-000021
surface:
  - plugins/ts
audience: both
evidence: repro
created: '2026-07-08T00:02:12.000Z'
---
**W5-a — `new QueryClient()` receiver not bound** — `callArgShapes` matches a member call
(`qc.invalidateQueries()`) only when the receiver came from the configured `hook`
(`const qc = useQueryClient()`), via the existing `collectHookBindings` machinery. A
`const qc = new QueryClient()` receiver (setup/test code, rare in app code) is NOT bound → the
member call under-reports. Generic fix: an optional `CallMatchSpec.constructors?: string[]`
(module-anchored class names whose `new C()` result is a member base, like `hook`). Deferred —
react-query covers it with a method-name `partial` fallback in its own policy. `feat`·`low`·`cx:M`

**Related:** t-000021 records the same unbound `new QueryClient()` receiver from the react-query side. One defect at two layers — candidates for a merge, not a dependency: neither blocks the other, since react-query can cover it in its own policy.
