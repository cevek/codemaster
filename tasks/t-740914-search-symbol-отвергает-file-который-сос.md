---
id: t-740914
title: "search_symbol отвергает file, который соседние ops принимают (bad_args: unrecognized 'file')"
status: backlog
priority: low
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: dx
complexity: S
area: ts-core
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:57.197Z'
---
## Симптом
`search_symbol {query:'append', file:'apps/server/src/sessions/part.ts'}` → bad_args unrecognized 'file'. Агенты переносят модель args с find_usages/source. Есть `pathInclude`.

## Минимальный исход
Intake-алиас `file` → `pathInclude:[file]` (§7 Postel), с раскрытием в `Result.intake`.

## Фрикшены
f-4akjfsgxjgmx, f-vmpepciueloi, f-5y7jb2cssewd

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
