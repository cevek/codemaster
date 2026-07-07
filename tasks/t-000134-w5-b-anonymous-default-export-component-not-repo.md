---
id: t-000134
title: "W5-b — anonymous default-export component not reported"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: framework-seams
created: '2026-07-08T00:02:13.000Z'
---
**W5-b — anonymous default-export component not reported** — `functionDeclarations` reports only
NAMED declarations; `export default () => <x/>` / `export default function () {}` has no name
token (the chainable anchor), so it is omitted (under-reports, never fabricates). A consumer that
wants it needs a synthetic name (e.g. the module basename) — react policy, not a ts-language fact.
`bug`·`low`·`cx:M`
