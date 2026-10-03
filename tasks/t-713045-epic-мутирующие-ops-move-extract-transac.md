---
id: t-713045
title: 'EPIC: мутирующие ops (move/extract/transaction) тратят 50–120 с на typecheck-гейт — сделать их юзабельными'
status: backlog
priority: high
tags:
  - epic
  - gate
  - mutation
  - perf
type: perf
complexity: L
evidence: measured
author: fad2132f
created: '2026-10-03T13:35:01.929Z'
---
## Проблема (замерено)

Репо-эталон: `/Users/cody/Dev/worktrees/amiro/pp-polish` — 3560 tracked TS, программа 5152 файла, `tsc --noEmit --extendedDiagnostics`: check 19.1 с.

- usage-лог (`~/.codemaster/usage/success.jsonl`): `transaction` в amiro — 75–120 с почти независимо от числа шагов (2 шага 73–102 с, 8 шагов 80–118 с, 13 шагов — 120 с = op Deadline); одиночные `move_symbol`/`move_file`/`extract_symbol` — 50–107 с; `rename_symbol` — 2–5 с (его check scope = touched).
- CPU-профиль одного `extract_symbol` dry-run (`node --cpu-prof`, 49 с): `gateAcross` 41.7 с (baseline ≈20 с + overlay ≈22 с, всё в `getSemanticDiagnostics`), план 5.8 с, captures 0.7 с.
- apply добавляет третий полный проход — post-apply `diagnosticsAcross` (`ops/refactor-apply.ts`, `ops/refactor-plan-apply.ts`).

## Механика

- `assemblePlan` (`plugins/ts/refactor/imports/assemble.ts`) расширяет `checkPaths` до всего `host.fileNames()` — §2.8 completeness backstop.
- `setOverlay`/`clearOverlay` (`program/single.ts`, `vfs/overlay.ts`) бампают версию проекта → каждый проход строит новый Program + новый TypeChecker → полная перепроверка. Пер-файловый кэш диагностики TS живёт внутри одного Program. BuilderProgram в `src` не используется.
- plan + gate + post-apply делят один op Deadline (120 с): 13-шаговая транзакция с `typecheck=clean` откатилась по `DeadlineExceeded` в избыточном post-apply проходе.

## Треки

1. Post-apply verify без полного прохода + таймаут после записи не откатывает (bug).
2. Кэш baseline-диагностики по дисковой версии программы (+ кэш overlay-результата для apply после такого же dry-run).
3. Спайк: SemanticDiagnosticsBuilderProgram поверх Program LS — замер на amiro, без прод-кода.

## Отвергнуто

- Свой граф импортёров вместо полного check scope: каждый забытый триггер (`export *`-barrel, `declare global` в переносимом блоке, non-module script, перенос вне tsconfig globs) = ложный `clean`.
- Отдельная overlay-программа рядом с дисковой: второй живой checker, +ГБ на in-process daemon (репо ниже порога эскалации) → OOM.
- Фоновый pre-warm baseline: блокирует общий loop in-process; кэш (трек 2) даёт тот же эффект.
