---
id: s-363919
title: cpu-slots вместо блокировки тестов
status: closed
author: mb-c5e4101d
assignee: mb-c5e4101d
created: '2026-11-19T07:59:50.727Z'
started: '2026-11-19T07:59:53.665Z'
closed: '2026-11-19T08:35:14.544Z'
---
## Итог
Тестовые скрипты на `cpu-slots-node --test` (слот на тест-файл, Linux), `scripts/with-test-lock.mjs` удалён, AGENTS.md/CONTRIBUTING переписаны (без обёртки, без `--test-timeout`, macOS без троттла). Попутно: `exit-seam-masking` на постоянном child (гонка одного чекаута), knip entry для спавнимых child-файлов.
Проверка на mini (Linux; Node 24 и Node 22 = CI): все 8 скриптов ждут слот до импорта файла, негатив-контроль различает; полный сьют — красный только `auto-escalate` (окружение, как на базе).
Бэклог: t-806699 (macOS без троттла), t-477634 (tsc/eslint/knip в `cpu-slots-run`), t-316440 (флейк daemon-cli-smoke), замер дописан в t-676217.
