---
id: t-378508
title: 'typecheck-гейт мутаций: overlay-проход проверяет всю программу — перевести на SemanticDiagnosticsBuilderProgram (замыкание referencedMap)'
status: backlog
priority: high
parent: t-116306
tags:
  - gate
  - mutation
  - perf
type: perf
complexity: L
evidence: measured
author: fad2132f
assignee: 0c78fe37
created: '2026-10-03T14:54:55.822Z'
---
Цифры, метод, эквивалентность, эскиз интеграции и риски — в отчёте спайка t-820012 (скрипты `scripts/spike/builder-gate/`). Кэш baseline (t-786607) и узкий post-apply (t-439159) уже убрали два из трёх полных проходов; остался overlay-проход гейта — полная проверка программы (~22–28 с на `/Users/cody/Dev/amiro`).

Builder-путь на overlay: ×25 для правок вне «ядра» (33% файлов amiro, ~0.9 с), ×1.5–2 в ядре (13–17 с — большая компонента обратных ссылок ~2070 файлов), ≈0 или хуже для hub-правок (сотни изменённых файлов).

Обязательные условия (из спайка): отказ от builder-пути при `assumeChangesOnlyAffectDirectDependencies` (доказанный ложный clean), `outFile`, `noCheck`; parity declaration-диагностики при `declaration`/`composite`; `releaseProgram()` после drain (иначе +0.7 ГБ); порог «изменено > N файлов ⇒ полный проход». Не замерены: транзакции, rename на builder-пути, частичный прогресс после cancel.
