---
id: t-000135
title: "W5-c — class components out of v1"
status: backlog
priority: low
type: feat
importance: low
complexity: M
area: framework-seams
created: '2026-07-08T00:02:14.000Z'
---
**W5-c — class components out of v1** — `functionDeclarations` covers function-like forms only;
a `class X extends Component { render() {…} }` is not surfaced as a component (its `render`
method IS reported as a `method` with `returnsJsx`, but the class itself is not). The react plugin
detects class components separately when needed. `feat`·`low`·`cx:M`
