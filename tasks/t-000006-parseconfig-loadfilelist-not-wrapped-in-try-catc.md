---
id: t-000006
title: parseConfig`/`loadFileList` not wrapped in try/catch (`single.ts` `reindex`)
status: backlog
priority: low
type: bug
complexity: S
area: multi-program
created: '2026-07-08T00:00:05.000Z'
---
**`parseConfig`/`loadFileList` not wrapped in try/catch (`single.ts` `reindex`)** — a throw
from `ts.parseJsonConfigFileContent` / `readConfigFile` would escape `reindex` to the agent,
against CONTRIBUTING "every external-tool call wrapped". Pre-existing, but now REACHABLE on a
tsconfig edit (the new structural trigger). Wrap → keep prior parse + honest note on failure.
`bug`·`low`·`cx:S`
