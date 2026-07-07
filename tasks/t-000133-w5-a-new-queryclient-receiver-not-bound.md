---
id: t-000133
title: W5-a — `new QueryClient()` receiver not bound
status: backlog
priority: low
type: feat
complexity: M
area: framework-seams
created: '2026-07-08T00:02:12.000Z'
---
**W5-a — `new QueryClient()` receiver not bound** — `callArgShapes` matches a member call
(`qc.invalidateQueries()`) only when the receiver came from the configured `hook`
(`const qc = useQueryClient()`), via the existing `collectHookBindings` machinery. A
`const qc = new QueryClient()` receiver (setup/test code, rare in app code) is NOT bound → the
member call under-reports. Generic fix: an optional `CallMatchSpec.constructors?: string[]`
(module-anchored class names whose `new C()` result is a member base, like `hook`). Deferred —
react-query covers it with a method-name `partial` fallback in its own policy. `feat`·`low`·`cx:M`
