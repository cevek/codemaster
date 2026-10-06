---
id: t-906818
title: 'EPIC: пакетный перенос файлов — 30 move_file в transaction шли 8 минут'
status: done
priority: high
tags:
  - epic
  - mutation
  - perf
  - transaction
type: perf
complexity: M
evidence: measured
author: fad2132f
created: '2026-10-06T13:16:32.250Z'
---
## Наблюдение (сессия агента в `/Users/cody/Dev/worktrees/amiro/pv2-z-landing`, 2026-10-06)

Переименование 30 файлов `src/local-api/{handlers,seed}/presale-v2-*` → `presale-*`: `transaction` из 30 `move_file` — 120 с → таймаут; затем 5 пачек по 5–7 шагов, отправленных параллельно, — по 51–68 с работы каждая, но последняя ждала в очереди ~3 мин (движок сериализует запросы workspace, §8). Итого ~8 мин. usage-лог (`~/.codemaster/usage/success.jsonl`) пишет `durationMs` без времени ожидания в очереди — 4-минутный вызов виден только по таймстемпам сессии агента.

## Замер (копия amiro, in-process, `node --cpu-prof`, CLI one-shot dry-run)

- 1 `move_file`: 57 с — гейт 36 с (холодный builder-baseline 21 с + overlay 15 с), план ~10 с, закрытие chokidar на выходе CLI 7 с.
- `transaction` из 3 `move_file`: 62 с — гейт 35 с, план 15 с (≈2.5 с на каждый доп. шаг: `rewriteImports` по всему дереву), закрытие chokidar 9 с.

## Треки
1. Склейка подряд идущих `move_file` в один план + время ожидания в очереди + выход CLI без ожидания закрытия watcher'а.
2. Расследование: `extract_symbol` в `pv2-kz-final` шёл 460 с при лимите op 120 с.
