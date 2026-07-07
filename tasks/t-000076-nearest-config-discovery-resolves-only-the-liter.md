---
id: t-000076
title: "nearest-config discovery resolves only the literal `tsconfig.json` basename"
status: backlog
priority: low
type: imp
importance: low
complexity: S
area: multi-program
created: '2026-07-08T00:01:15.000Z'
---
**nearest-config discovery resolves only the literal `tsconfig.json` basename** — `ensureProgramFor`
walks up via `ts.findConfigFile` (hardcoded `tsconfig.json`); a nested config with a non-standard name
(`tsconfig.app.json`) isn't loaded by the read-path fix, so its alias-only usages fall to the honest
floor (`complete:false`) rather than being found. Common `package/tsconfig.json` is covered. `imp`·`low`·`cx:S`
