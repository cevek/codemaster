---
id: t-786607
title: typecheck-гейт мутаций пересчитывает baseline-диагностику всей программы на каждом вызове — кэшировать по дисковой версии программы
status: backlog
priority: high
parent: t-713045
tags:
  - cache
  - gate
  - mutation
  - perf
type: perf
complexity: M
evidence: measured
author: fad2132f
created: '2026-10-03T13:35:18.321Z'
---
Контекст и замеры — эпик t-713045.

## Проблема

`gateAcross` (`plugins/ts/program-gate.ts`) на каждом move/extract/codemod/transaction считает baseline (диск) по всей программе ≈20 с на эталонном репо, хотя это чистая функция дискового состояния. `SingleProgram.version` (`program/single.ts`) один и бампается и reindex'ом, и `setOverlay`/`clearOverlay` — поэтому ключевать кэш по нему нельзя.

## Решённое направление (менеджер; детали — твой план)

- Отдельная «дисковая» версия на программу (меняется только reindex/loadFileList и §3.5-дрейфом); кэш baseline `TsDiagnostic[]` per program по полному file-set, фильтр до `checkAbs` при использовании — симметрия baseline/overlay (инварианты 1–2 в шапке `program-gate.ts`) сохраняется. Cancelled/partial сбор не кэшируется.
- Кэш overlay-результата по ключу `дисковая версия ⊕ hash(overlayFiles, removed, checkAbs)` — apply после идентичного dry-run пропускает гейт.
- Дрейф, который LS сам не видит (`node_modules`/lockfile/`package.json`/`.d.ts`, `extends` с не-tsconfig basename) — инвалидировать; решить в плане, как именно.
- §3.1 (кэш только с жёсткой инвалидацией), §16 cold == warm — обязательны.

Гипотеза, не рамка: опровергнешь посылку по коду — доложи.
