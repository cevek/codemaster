---
id: t-000101
title: fold-imports.ts` git-classified as BINARY
status: backlog
priority: low
type: infra
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:40.000Z'
---
**`fold-imports.ts` git-classified as BINARY** (same as `socket-path.ts`) — `git grep` without
`-a` misses it. A repo-wide `.gitattributes` `*.ts text` would fix both this and the socket-path
B2 residual in one stroke; do them together. `infra`·`low`·`cx:S`
