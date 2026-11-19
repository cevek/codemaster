---
id: t-676217
title: 'Флейк: usage-log-inflight «a claim left by a promoter that itself died is recovered» падает под полным сьютом'
status: todo
priority: medium
tags:
  - tests
created_by_session: s-558685
type: bug
complexity: S
area: platform
evidence: measured
author: mb-6ffb47cd
created: '2026-11-17T10:46:41.896Z'
---
Тест `a claim left by a promoter that itself died is recovered, not lost forever` (`test/e2e/usage-log-inflight.test.ts`) упал один раз в полном прогоне `node scripts/with-test-lock.mjs -- npm test` (ветка watcher-fd-budget @8aea30c, 1653 теста, 1 fail): `an orphaned CLAIM must still be reconciled`, `0 !== 1` — второй проход `promoteOrphanInflight` не подобрал claim. Отдельно по пути — 3/3 зелёных на той же ветке и зелёный на main a57bc0e. Диф ветки модуль usage-log не трогает.

Причина не установлена. Подозрение, не проверенное: проход 2 решает «claimer мёртв» по живости pid `DEAD_PID + 1` (и сравнивает время `now`), а под нагрузкой сьюта одно из этих допущений неверно.


Главный подозреваемый: «мёртвые» pid берутся как `DEAD_PID+1`/`+2` от только что завершившегося ребёнка (`DEAD_PID = done.pid`). Под нагрузкой сьюта следующий pid вероятно занят живым соседним процессом, и claimer считается живым.


Замер 2026-11-19 (mini, Linux 16 CPU, Node 24, load 17–45 от чужих агентов; t-011900): два одновременных полных `npm test` из разных копий — на `cpu-slots-node` (e9b6723/75d0d03) тест упал в 2 прогонах из 4, на базе 92fd920 (`node --test`, без слотов) — в 0 из 4 (1 одиночный + 2 параллельных + 1 одиночный вершины — 0). Сообщение то же: `0 !== 1`, 3 ms. Частота растёт с числом процессов на машине — согласуется с подозрением «`DEAD_PID+1`/`+2` занят живым процессом», не доказывает его.
