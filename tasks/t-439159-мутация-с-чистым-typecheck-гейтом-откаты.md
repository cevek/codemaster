---
id: t-439159
title: Мутация с чистым typecheck-гейтом откатывается по таймауту избыточного post-apply прохода; post-apply = третья полная проверка программы
status: review
priority: high
parent: t-713045
tags:
  - gate
  - honesty
  - mutation
  - perf
type: bug
complexity: M
evidence: measured
author: fad2132f
assignee: 0da85b47
created: '2026-10-03T13:35:11.681Z'
---
Контекст и замеры — эпик t-713045.

## Дефект

- Post-apply `diagnosticsAcross` (`plugins/ts/program-gate.ts`, вызов в `ops/refactor-apply.ts` и `ops/refactor-plan-apply.ts`) — третий полный проход проверки по уже проверенным overlay-гейтом байтам; на эталонном репо ≈20 с.
- Он делит один op Deadline с планом и гейтом. Наблюдалось: `transaction` из 13 шагов, ответ `typecheck=clean`, `rollback.performed=true`, `reason=post-apply typecheck threw (DeadlineExceededError…)` — откат доказанно безопасной правки (§3.6 наоборот).

## Решённое направление (менеджер; детали — твой план)

- Таймаут/отмена ПОСЛЕ записи никогда не вызывает rollback: правка остаётся, на конверте честная нота, что финальная проверка не завершилась. Rollback — только на доказанную ошибку.
- Полный post-apply проход заменить дешёвой проверкой того, что гейт НЕ покрыл: readback записанных байтов против проверенных; §3.5-отпечаток репо перед записью (отказ при дрейфе с момента входа) — сегодня его нет; диагностика по touched ∪ new (как rename). Узкий residual (dest вне glob всех программ, `claimedBy` в `program-gate.ts`) — решить в плане.
- Два почти одинаковых post-apply блока — свести в одно место.

Гипотеза, не рамка: опровергнешь посылку по коду — доложи.


## План

Посылки постановки по коду подтверждены (base 59d6791 / вершина e5ae5ce): post-apply в `applyMutation` (`ops/refactor-apply.ts`) и `applyRefactorPlan` (`ops/refactor-plan-apply.ts`) зовёт `ts.diagnosticsAcross(gateScope, gateProgms, ctx.deadline)` с тем же `check`, что и гейт (`plan.checkPaths` = весь `host.fileNames()` для move/extract/transaction/change_signature; `allProgramTsFiles()` для codemod; touched для rename); ЛЮБОЙ throw из `reindex`/`diagnosticsAcross` (включая `DeadlineExceededError`) → `revertAll`/`rollback`. Репо-отпечатка перед записью нет — только `dirtyAmong` по touched.

### Замер «до» (эталон `/Users/cody/Dev/amiro` @ ec82d2be8, APFS-клон, CLI one-shot, base-код)
`extract_symbol {name:toOptions, file:src/lib/forms/choice-option.ts, dest:src/lib/forms/choice-options-seed.ts}` (20 touched): dry-run real 84.4 с / user 80.7 с; apply real 125.4 с / user 120.8 с. **apply − dry-run = 41 с real / 40 с user** — это и есть post-apply (полный проход + reindex). load avg 17–50 (параллельные треки) — сравнивать по разности и по user-CPU. «После» — тот же вызов, тот же клон-источник.

### Подход: один модуль `src/ops/post-apply-verify.ts`, оба хелпера сводятся к вызову
1. **Вход хелпера (до гейта)**: `captureWorktree(root)` — `gitRepoFingerprint` (HEAD + porcelain) + stat-отпечаток (size+mtime, хэш контента на racy-tie через существующие `statFingerprint`/`compareFingerprints`/`hashFileContent`) каждого dirty-пути. Новый файл `support/git/worktree-snapshot.ts` (capture + compare → список изменившихся путей).
2. **Перед записью** (на месте `dirtyAmong`, одна git status вместо двух): (a) повторный снимок; отличие от входного → refuse в dry-run-форме «репо изменилось во время операции: <пути> — ничего не записано, перезапусти»; (b) `disk(path) === before` для каждого restore-пути (rename: `c.before`; plan: `plan.diff[].before` по `d.from`) — закрывает тихое затирание чужой правки при `dirtyOk`; (c) dirty-among-touched считается из того же снимка. Сбой снимка (git) → refuse (не можем доказать отсутствие дрейфа) — сегодня `dirtyAmong` в той же ситуации тоже fail.
3. **После записи** `verifyAfterWrite` → вердикт `verified | introduced(field) | incomplete(reason)`:
   - readback: каждый записанный путь == проверенные overlay байты; каждый removed путь отсутствует. Расхождение → `incomplete` (НЕ rollback: после атомарной записи расхождение значит чужого писателя; rollback затёр бы его правку `before`-байтами), recheck пропускается — он был бы про чужие байты.
   - `ts.reindex(touched)`; throw → `incomplete`.
   - recheck: `ts.diagnosticsAcross({anchor, check: written TS-пути (touched ∪ new, без removed)}, gateProgms, deadline)` — узкий scope, тот же pinned набор программ, тот же `remapBaselineFile`; дифф против того же baseline (`buildTypecheckField`, multiset: подмножество ⊆ overlay ⊆ baseline ⇒ clean при равных байтах и равном членстве). `DeadlineExceededError`/любой throw → `incomplete`; introduced → `introduced` (единственный путь в rollback, кроме сбоя самой записи).
   - **Residual членства (решение)**: узкий recheck корректен, только если post-reindex программы содержат каждый записанный путь РОВНО там, куда его клал overlay-гейт. Это ломается в двух местах: `claimedBy`-фолбэк (dest вне glob всех программ → overlay force-add'ит его как root в primary; на диске его не включает никто, если не импортируют) и glob-да-но-junk (gitignored dest: `mayContain` true, `loadFileList` исключает). Конкретный ложный clean: перенос `declare global`-файла в каталог вне `include` — overlay видит глобалы (root), диск нет, ломаются НЕ-touched потребители, узкий recheck их не смотрит. Поэтому: до записи снимаю `claims` (путь → метки программ из gate-набора, куда overlay его положил: тот же `affected(anchor)` + `claimedBy`), после reindex — фактическое `containsFile`; расхождение хоть по одному пути ИЛИ touched не-TS путь (tsconfig/json/scss при move каталога — overlay не моделирует) → recheck расширяется до полного `scope.check` (сегодняшнее поведение, но timeout всё равно = `incomplete`, не rollback). Две новые экспортируемые функции в `plugins/ts/program-gate.ts` (`overlayClaims`, `containmentAcross`) + проброс через `ls-host.ts`/`api.ts`/`plugin.ts`; **`gateAcross` не трогаю** (переиспользую приватные `affected`/`claimedBy` только на чтение).
4. **Конверт**: applied-success несёт `typecheck` = поле ГЕЙТА (полный scope; узкий recheck дал бы другой `preExisting` — сегодня они совпадают, после сужения нет). При `incomplete` — `applied:true`, `rollback:{performed:false}`, плюс поле `postApply:{complete:false, reason}` в вердикт-зоне (до tail) и нота «финальная проверка не завершилась (<причина>); правка проверена overlay-гейтом до записи». При `verified` конверт байт-в-байт как сегодня (поля `postApply` нет). Текст `failTimeoutOr` («no files were written») на post-write пути НЕ используется.

### Развилки
- Точка снимка «вход»: вход хелпера (выбрано) vs `runOne` движка для `mutating && apply` (закрыл бы окно планирования ~6 с, но правит общие `engine.ts`/`OpContext`). Residual: не-touched импортёр, изменённый внешне в окне планирования (до входа хелпера), отпечатком не ловится — touched-файлы ловит проверка (2b). Завожу таску на перенос в движок.
- Readback-mismatch: incomplete без rollback (выбрано) vs rollback (затирает чужую правку).
- Residual членства: детектор claims-vs-containment + расширение (выбрано) vs «принять» (ложный clean на `declare global` вне glob — регресс против сегодняшнего полного прохода).

### Как доказываю поведение
- `test/helpers/project.ts`: опция `wrapTs?: (api, {clock, write}) => TsPluginApi` (обобщение `faultTsMethod`, реальный движок + реальный git-фикстур).
- e2e (новый `test/e2e/post-apply-verify.test.ts`): (a) дедлайн истекает ПОСЛЕ записи (обёртка `reindex` двигает manual clock за бюджет; настоящий `withDeadline` бросает) → файлы новые на диске, `applied:true`, `rollback.performed:false`, `postApply.complete:false` — для rename (applyMutation) и move_file (applyRefactorPlan); (b) внешняя правка не-touched файла во время гейта (обёртка `gateAcross` пишет файл) → refuse, git-дерево = только внешняя правка; (c) touched-файл перемодифицирован после плана при `dirtyOk` → refuse, чужая правка цела; (d) residual: move `declare global`-файла в каталог вне `include` → overlay clean, расширенный recheck находит ошибку потребителя → rollback (покраснеет, если детектор членства убрать — проверю мутацией); (e) узкий scope: обёртка `diagnosticsAcross` записывает `scope.check` → для move_file это written-пути, не весь `checkPaths` (пиннит решение по perf). Мутационная проверка (a)/(b)/(d).
- Живой: тот же `extract_symbol` apply на клоне amiro, «после» vs «до» по apply − dry-run и user-CPU.
- Не покрыто: readback-mismatch (нужна инъекция в слой записи/параллельный писатель между write и readback — достижимо только через обёртку `reindex`, сделаю если дёшево, иначе в «не покрыто»).

### Строки, которые правка сделает ложью (чиню сам)
header `refactor-apply.ts` (шаг 3), комментарий у `gateAcross`/`diagnosticsAcross` в `plugin.ts`, doc `diagnosticsAcross` в `program-gate.ts` и `api.ts`, ARCHITECTURE §7 (apply-абзац, если упоминает post-apply), концепт `mutating-gate` в `format/render/concepts.ts` + `test/golden/status.golden.txt`.

### Ревью
plan-reviewer (1 круг); на код — bug-reviewer (обязательно, до 2 кругов по правилу брифа). Файлы > 300 строк не растут: оба хелпера сокращаются.


### Правки плана по plan-ревью (1 круг, [BLOCK] нет, 9 should-fix)
- Дрейф-снимок сужен до путей, способных сменить вердикт: dirty-набор минус `isJunkRelPath`, из остатка — program-расширения (`isTsLike`, вкл. `.js`/`.d.ts`) + `tsconfig*.json`/`package.json`/`.gitignore` + touched. `.DS_Store`/логи не дают отказ. Снимок hash-only (контент-хэш отфильтрованного dirty-набора) — без stat/racy-tie, без часов, без дубля `daemon/freshness.ts`.
- Триггер widen по не-TS сужен до структурных файлов (`tsconfig*`, `.gitignore`, `package.json` — то, что `single.ts reindex` считает structural); `.scss`/`.md` не расширяют (css co-extract и dir-move со стилями остаются на узком пути). «Записанный TS-путь» = `isTsLike` (единственный предикат).
- `overlayClaims` снимается ДО `gateAcross` (та же версия программ, что строит гейт — без лишнего `getProgram`), post-reindex `containmentAcross` идёт непосредственно перед recheck, между ними версию ничто не бампает. Removed-пути из детектора исключены.
- `ls-host.ts` у капа 300: ОДИН новый метод хоста (`gateMembership(scope, paths, phase)`), не два.
- Readback сверяет с тем, что реально писали (rename: `after`; plan: `commitPlan.newFiles/contentWrites` + байты moved-файлов по `contentMap`), не с `overlayFiles` (там только TS). Mismatch → `postApply.reason` прямо говорит «на диске байты, которых операция не писала: <пути>; поле typecheck описывает записанное, а не текущее»; `reindex` после mismatch всё равно best-effort.
- Тест (d): сирота — `.ts` с `declare global {…}; export {}`, никто не импортирует, потребители используют глобал, dest вне всех `include` и не gitignored. + тест «`reindex` throw → incomplete» той же обёрткой; пин «move_file каталога с `.scss` идёт узким путём».
- Развилка residual: альтернатива — сделать overlay верным членству (не force-add'ить в roots ключи, не owned программой; достижимость только через `fileExists`/`readFile`) — убрала бы класс целиком. Не беру: это `single.ts`/семантика гейта (зона соседнего трека t-786607) и риск ложных «Cannot find module»; завожу таску.
- Окно планирования: гейт читает диск в момент гейта, т.е. не-touched импортёры видит; незакрытым оставалось только `before` vs диск для touched — закрыто 2(b). Таску на перенос снимка в движок НЕ завожу.
- git status: 2 вызова на apply (вход + пре-запись) вместо 1 (`dirtyAmong`) — +сотни мс, пренебрежимо.
- Сосед t-786607: `overlayClaims` использует приватные `affected`/`claimedBy` из `program-gate.ts`; если их кэш мемоизирует `affected`/меняет `programs` — claims должны идти в ногу. Сообщаю менеджеру.


## Результат

### Замер (эталон amiro, APFS-клон, CLI one-shot, `extract_symbol toOptions → choice-options-seed.ts`, 20 touched)
- До (base 59d6791, amiro ec82d2be8, load 17–50): dry-run 84.4 c real / 80.7 user; apply 125.4 / 120.8 → **apply − dry-run = +41 c real / +40 c user**.
- После (219523d, amiro 032b2b449 — HEAD уехал, load 47–127): dry-run 106.0 / 89.5; apply 78.5 / 76.6 → **apply − dry-run ≤ 0** (в шуме). Post-apply больше не содержит полного прохода. Абсолютные числа между прогонами несравнимы (нагрузка и HEAD разные) — сравнивается разность внутри пары.

### Факты о системе, вскрытые по ходу
- Отмена LS (`cancellation.ts`) срабатывает только внутри checker-узлов, которые опрашивают токен (тело функции — да, `export const x = 1` — нет). Recheck, запущенный на уже истёкшем бюджете, может досчитать до конца → в `verifyAfterWrite` явная проверка `deadline.expired()` до старта.
- Снимок, оставленный pending до синхронного гейта, читал бы хэши после гейта (40+ с) — поэтому `captureEntry` awaited до гейта.
- Все продюсеры `before` (rename `sourceFile.text`, codemod/assemble/transaction `readFileSync`) сохраняют BOM/CRLF; снапшоты LS — `readFileSync(…,'utf8')`, не `ts.sys.readFile`. Сравнение before/readback — только сырые байты (первая версия срезала BOM и ложно отказывала на любом BOM-файле — поймано ревью).

### Опровергнуто/отвергнуто
- Rollback на readback-mismatch: после атомарной записи расхождение = чужой писатель, rollback затёр бы его правку `before`-байтами → `incomplete`.
- «Residual claimedBy покрыт overlay+readback»: неверно — overlay force-add'ит неowned dest в roots, на диске сирота вне `include` не в программе; `declare global` в нём ломает НЕ-записанные файлы. Закрыто детектором членства (`claimDivergence` → полный scope), класс целиком — t-433767.

### Не покрыто
- Окно между планированием и `captureEntry` для НЕ-touched файлов: гейт читает диск в момент гейта, т.е. видит их; для touched — проверка before-bytes.
- Забор дрейфа шире scope гейта — t-500739; root-подкаталог git-репо — t-835778 (унаследовано от `dirtyAmong`).
