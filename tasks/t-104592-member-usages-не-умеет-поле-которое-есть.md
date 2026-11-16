---
id: t-104592
title: member_usages не умеет поле, которое есть только в части вариантов union (AssistantBlock.input)
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: feat
complexity: M
area: ts-core
relates:
  - t-031616
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:54.671Z'
---
## Симптом
`member_usages {name:'AssistantBlock', file:'packages/chat-model/src/types.ts', member:'input'}` → FAIL no type at the resolved position. `AssistantBlock` — union, `input` есть в вариантах tool/server-tool/image-gen. Агент ищет читателей текстом.

## Минимальный исход
Честная половина: на union-alias вместо `no type at the resolved position` — ошибка, называющая варианты, где член есть (runnable: member_usages по каждому варианту). Полная — объединение ссылок по содержащим вариантам.

## Фрикшены
f-r32fwre5g2rk
Inbox: «member_usages не поддерживает поле варианта discriminated union» (2026-11-15T16:00).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
