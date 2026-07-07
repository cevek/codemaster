---
id: t-000002
title: socket-path.ts` is git-classified BINARY
status: backlog
priority: low
type: infra
complexity: S
area: platform
created: '2026-07-08T00:00:01.000Z'
---
**`socket-path.ts` is git-classified BINARY** (numstat `- -`, `Bin` in diff) despite 0 NUL /
valid UTF-8 — the fix's core shows as "Binary files differ" in plain `git diff`, hiding it
from review (needs `git diff -a`). Since file creation (bc3003b). Fix: `.gitattributes`
`*.ts text`, or find the trigger byte. No runtime impact. `infra`·`low`·`cx:S`
