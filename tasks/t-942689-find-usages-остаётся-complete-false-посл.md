---
id: t-942689
title: find_usages остаётся complete=false после явной загрузки всех undiscoveredPrograms через programs
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: bug
complexity: M
area: multi-program
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:50.990Z'
---
## Симптом
`find_usages` называет 5 `undiscoveredPrograms`; повтор с `programs:[…эти 5…]` их загружает, но `programsFloored` всё равно держит `complete=false`. Агент не может добиться полного ответа ни одним рычагом, который ему назвали — это inert-lever (§3.6, `ops/guard/navigate.ts` doctrine).

## Минимальный исход
Либо загруженный конфиг вычитается из пола, либо нота называет ДРУГУЮ, реальную причину пола. Проверить логику вычитания в `program/coverage.ts` (undiscovered memo) для конфигов, загруженных через `programs`.

## Фрикшены
f-3tcrgyavsb3x, f-3sod7u42zxwq, f-ll2aigbzg3o5

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
