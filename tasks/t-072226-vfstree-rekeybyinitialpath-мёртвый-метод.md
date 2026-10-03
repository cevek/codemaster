---
id: t-072226
title: VFSTree.rekeyByInitialPath — мёртвый метод с ложным комментарием о re-target в extract
status: backlog
priority: low
tags:
  - ts-refactor
type: dx
complexity: S
area: ts-refactor
evidence: repro
author: f0182919
created: '2026-10-03T16:02:19.919Z'
---
`VFSTree.rekeyByInitialPath` (`src/plugins/ts/refactor/tree/tree.ts`) не вызывается нигде в `src` (проверено на 8918d9c plan-ревьювером t-749107), а его док-комментарий описывает re-target синтетического файла в extract, которого нет: `planExtractTo` (`refactor/extract/move-to-file.ts`) создаёт файл сразу в dest через `addFileAtCurrent`. knip метод класса не снимает. Удалить метод (компилятор докажет безопасность) — комментарий врёт о механике extract.
