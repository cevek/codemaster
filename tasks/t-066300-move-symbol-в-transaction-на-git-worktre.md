---
id: t-066300
title: "move_symbol в transaction на git worktree: 'source file not in the TS project'"
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
created: '2026-11-16T09:41:56.234Z'
---
## Симптом
`transaction {root:'~/Dev/worktrees/claude-ui/lab-on-product', steps:[move_symbol DeviceEntry → apps/web/src/lib/deviceRows.ts]}` → FAIL step 0 could not be planned: source file not in the TS project. Файл — в apps/web (member-программа). Гипотеза: в transaction write-site фан выключен (ARCHITECTURE §5-L2), а планирование смотрит только primary, который apps/web не включает.

## Минимальный исход
Ошибка называет, в какой программе файл есть и как адресоваться (`root:<pkg>`), вместо «not in the TS project».

## Фрикшены
f-3aszxbjgcip7

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
