---
id: t-684080
title: 'move_file: overlay-проход гейта перепроверяет ~2000 файлов замыкания удалённого пути (~15 с на amiro) — выяснить, законно ли это по модели TS или «штраф первого перехода»'
status: backlog
priority: medium
tags:
  - gate
  - mutation
  - perf
type: perf
complexity: M
evidence: measured
author: fad2132f
created: '2026-10-06T13:16:57.016Z'
---
Профиль одного `move_file` dry-run на копии amiro (эпик t-906818): overlay-проход builder-гейта (`plugins/ts/program-gate-builder.ts`) ≈15 с; спайк t-820012 мерил move-file — 2072 перепроверенных файла = замыкание удалённого `recorderStore.ts`, причину не установил (pre-sign не помог). Исследовать без прод-кода: какие файлы builder считает сменившими сигнатуру при переносе (импортёры с изменённым спецификатором? холодные версии вместо d.ts-сигнатур?), и можно ли это сузить, не выходя из модели TS (свой граф импортёров отвергнут — ложный clean).
