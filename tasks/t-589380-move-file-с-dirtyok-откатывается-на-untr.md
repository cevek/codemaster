---
id: t-589380
title: 'move_file с dirtyOk откатывается на untracked-файле: git mv fatal: not under version control'
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: bug
complexity: S
area: ts-refactor
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:55.672Z'
---
## Симптом
`move_file {from:'src/runtime/env-author.ts', to:'src/common/env-author.ts', apply:true, dirtyOk:true}` → `rollback performed=true reason=commit failed (git mv …: fatal: not under version control)`. Файл только что создан, не закоммичен.

## Минимальный исход
Untracked-источник переносится обычным rename (fs), `git mv` — только для tracked.

## Фрикшены
f-sjbusgfud5hf

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
