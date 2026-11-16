---
id: t-887436
title: move_symbol уносит с константой JSDoc-блок, описывающий соседнюю декларацию
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
created: '2026-11-16T09:41:55.173Z'
---
## Симптом
`move_symbol {name:'DEFAULT_PAGE_LIMIT', file:'src/mcp/schemas.ts', dest:'src/api/paginate.ts', apply:true}` (task-manager): над константой стоял один JSDoc, описывающий в основном `pageArgs` ниже. Блок уехал целиком в dest (с пустой строкой между комментарием и константой), у `pageArgs` комментарий пропал.

## Минимальный исход
Как минимум — мутация называет в выводе перенесённые leading-комментарии (пост-условие видно до apply). Решение, чей комментарий, — развилка (LS 'Move to file' берёт leading trivia).

## Фрикшены
f-54ougqv4xyra

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
