---
id: t-011900
title: 'Test runs: cpu-slots per test file instead of the whole-run lock'
status: done
priority: high
assigned_to_session: s-363919
type: infra
complexity: S
evidence: measured
author: mb-c5e4101d
created: '2026-11-19T07:59:54.011Z'
---
## Задача
Тестовые прогоны — на машинных CPU-слотах (`cpu-slots@0.1.1`, devDependency): слот на тест-файл,
ожидание до старта часов файла. Блокировка всего прогона (`scripts/with-test-lock.mjs`, K=1) уходит.
Зачем: на Linux-хостах агентов (16 CPU, 10–20 агентов) параллельные полные сьюты падают по таймауту;
K=1 сериализует целые прогоны, хвост держит машину.

## План
Скоуп-файлы:
- `package.json`: 8 `test*` скриптов — `node --test` → `cpu-slots-node --test`; префикс
  `NODE_COMPILE_CACHE`, `${TEST_CONCURRENCY:+…}` и репортёры `test:timing` без изменений.
  devDependency `cpu-slots@^0.1.1`.
- `package-lock.json`: только запись `cpu-slots` (npm 11.6.2 с homebrew при `npm i` ещё вырезает
  `@emnapi/core|runtime` — шум, не берём; правка руками, проверка — `npm ci` на mini и на маке).
- `scripts/with-test-lock.mjs` — удалить (ссылки: AGENTS.md «Gate», CONTRIBUTING «The gate», тело t-350294).
- `AGENTS.md` «Gate», `CONTRIBUTING.md` «The gate»: полный прогон — просто `npm test`, без обёртки;
  точечный прогон тяжёлого файла — `npx cpu-slots-node --test <file>`; macOS — слотов нет (no-op),
  машинного троттла нет, `TEST_CONCURRENCY` по-прежнему читается скриптами.
- t-350294: фраза про test-lock → про `npm test` (find/replace).

Развилки:
- macOS: cpu-slots no-op → с удалением блокировки на маке машинного троттла нет. Выбор: блокировку
  удаляем целиком (бриф; два механизма + инструкция «оборачивай» хуже), пробел — в CONTRIBUTING явно и
  отдельной таской в бэклог.
- Дефолт `TEST_CONCURRENCY = cores−4`, который ставила блокировка, уходит вместе с ней: слоты
  ограничивают машину целиком; переменная остаётся ручкой.
- `--test-timeout`: нигде нет (скрипты, CI, `.npmrc`/`node.config.json` отсутствуют). На Node 22
  (CI `.nvmrc`) ожидание слота засчитывалось бы в него — фиксирую в CONTRIBUTING как запрет.
- Вложенные процессы: `fork` в `src/daemon/fork-engine.ts` наследует `execArgv` (preload) и
  `...process.env` (`CPU_SLOTS_HELD`) → своего слота не ждёт. Все `env:` в тестах спредят
  `process.env`. Детачнутый демон (`spawn-daemon.ts`, `spawn(process.execPath)`) preload не получает.
- Обёртка `fix-and-check`/`check` (tsc/eslint/knip) в `cpu-slots-run` — вне скоупа, таска в бэклог.

Проверка (Linux, mini; на маке слоты no-op):
1. Полный сьют на базе `92fd920` и на вершине — список красных до/после.
2. Слоты подключены в КАЖДОМ `test*` скрипте: `CPU_SLOTS=1 CPU_SLOTS_POOL=<уник.>`, держатель
   `npx cpu-slots-run -- sleep 30`, `ss -xlp` видит его; каждый скрипт в том же env с таймстемпами —
   ноль вывода тестов пока держатель жив; один дешёвый скрипт после освобождения — зелёный.
   Негатив-контроль: тот же сценарий на `node --test` даёт вывод сразу (иначе проба не различает).
3. `npm ci` с правленым lockfile на mini (npm 10/11) и на маке.
4. Гейт `npm run fix-and-check` (knip видит бин `cpu-slots-node` → пакет используется).

Тестов в коде не пишу: правка — конфигурация раннера, её поведение доказывает проба п.2 на
настоящей поверхности (npm script → node --test → preload → abstract socket).

Ревью: bug-reviewer (1 круг), project-docs-reviewer (AGENTS.md тронут, 1 круг).


## Разбор
- knip: его node-плагин распознаёт `node --test` в скриптах `package.json` и берёт ВСЁ под `test/`
  как entry; `cpu-slots-node --test` он не знает → три файла, которые тесты запускают по пути
  (`test/e2e/*.child.ts`, `test/e2e/watchdog-harness.ts`), стали «Unused files». Лечение — явные
  entry в `knip.jsonc`. Побочный риск (helper'ы под `test/` перестали быть entry → knip
  `--fix-type exports` мог бы снять их «мёртвые» экспорты) не сработал: `fix-and-check` ничего не тронул.
- `npm i -D` npm 11.6.2 (homebrew) вырезает из lockfile `@emnapi/core|runtime` (опц. зависимости
  wasm32-биндингов oxc) — шум, в коммит не взят; запись `cpu-slots` добавлена в lockfile руками.
- t-350294 (done) упоминает test-lock — исторический текст, не трогал.


## Проверка (mini: Linux, 16 CPU, Node 24.22.3, npm 11.19.1; load 12–45 от чужих агентов)
- `npm ci` с ручным lockfile: 0 (mini, npm 11.19.1); `npm ci --dry-run` на npm 10.9.9/11.6.2 — ок (bug-reviewer).
- Проба слотов (CPU_SLOTS=1, свой пул, внешний держатель `cpu-slots-run -- sleep`, проба-файл `000-slot-probe.test.ts` в каждой папке): все 8 скриптов — процесс файла поднят, импортов за 4 с удержания 0, после освобождения файл импортирован и `ss -xlp` показывает слот за его pid. Негатив-контроль: голый `node --test` при занятом слоте импортирует через 80 ms. `test:golden` при CPU_SLOTS=1 доходит до конца, exit 0.
- `process-isolation.test.ts` при CPU_SLOTS=1 (fork с preload и CPU_SLOTS_HELD): 4/4, 5.4 s — вложенные процессы своего слота не ждут.
- Полный сьют, 1653 теста: база 92fd920 одиночно — 1 fail; вершина 75d0d03 одиночно — 1 fail (тот же); 2× база параллельно — по 1 fail; 2× вершина параллельно: пара 75d0d03 — 3 и 1 fail, пара e9b6723 — 1 и 2 fail.
  Node 22.23.5 / npm 10.9.9 (= CI), свежий `npm ci`, e9b6723 одиночно — 1 fail (тот же); проба `test:unit`, `test:e2e` + негатив-контроль — OK.
  Общий красный — `auto-escalate.test.ts:116` (`estimate-failed`): копия из `git archive` без `.git`, оценка размера идёт через git — окружение (в git-чекауте на маке файл 6/6 зелёный).
  Сверх него на вершине под двумя параллельными прогонами: `usage-log-inflight` ×2 (флейк t-676217, туда дописан замер) и `daemon-cli-smoke` ×1 (t-316440).
- macOS: не прогонялся полностью — слоты no-op, поведение = старое без блокировки.
