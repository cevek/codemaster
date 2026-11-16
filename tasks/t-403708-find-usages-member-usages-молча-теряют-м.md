---
id: t-403708
title: find_usages / member_usages молча теряют межпакетных потребителей, импортирующих символ через workspace-пакет (снапшот без node_modules)
status: done
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: bug
complexity: M
area: multi-program
audience: external
evidence: reported
author: mb-ce356acc
assignee: mi-5302e415
created: '2026-11-16T09:41:50.537Z'
---
## Симптом
На read-only снапшотах claude-ui (дерево без `node_modules`) `find_usages` по `name+file` возвращает только объявление (+ in-file use), а `member_usages` — 0 мест, хотя реальные потребители в `apps/server` / `apps/web` импортируют символ через `@claude-ui/protocol` / `@claude-ui/agent-core`.
Примеры: `ChatPromptPart` (packages/protocol/src/chatPrompt.ts → apps/web ChatPrompt.tsx), `systemText` (agent-core → agent-anthropic/codex/grok/agy), `pickReviewers` / `reviewHeadText` / `reviewerPickOf` (protocol reviewerPick.ts → apps/server mesh/oneShotTools.ts), `RoleInfo.family` (→ skillTools.ts, oneShotTools.ts). `mergeDeclarations:true` показывает вызов как отдельный alias — т.е. импорт резолвится в ДРУГОЙ символ (вероятно, workspace-спецификатор без node_modules-симлинка не доходит до исходника).

## Почему это ложь
`complete=false` выставлен, но `undiscoveredPrograms` не называет `apps/server/tsconfig.json` — причина неполноты указана неверно, агент не может догадаться, что теряются именно workspace-ссылки (§3.4/§3.6).

## Минимальный исход
Честная половина: когда workspace-спецификатор (`@scope/pkg` из `workspaces`/pnpm-workspace) не резолвится в файл репо — дисклоузить это в ответе (какие спецификаторы, какой пакет), а не молчать. Полная половина (резолв workspace-пакета к его исходнику без node_modules через package.json `exports`/`main`) — развилка, отдельно.
Смежное: `construction_sites` в таком снапшоте видит все типы как `any` (f-cr5yykmpslke).

## Фрикшены
f-yryfwts6foiq, f-ydob65mx2la6, f-73no7yqc753m, f-5f4bg2yo464s, f-6mlodylvorjt, f-o53yqwdk5byt, f-jpyvrdskwifw, f-cr5yykmpslke
Inbox: «find_usages omits known re-exported workspace consumers» (2026-11-16T06:26), «find_usages в snapshot не связывает exported declaration с workspace consumer» (2026-11-16T08:16), «member_usages(RoleInfo.family) возвращает 0» (2026-11-16T08:45).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.


## План

**Диагноз подтверждён** (снапшот claude-ui `e4f930a2`, CLI one-shot): `find_usages systemText` → 1 место (decl). `ts.resolveModuleName('@claude-ui/agent-core', packages/agent-grok/src/query.ts)` без `node_modules` → `null`; в живом чекауте → `packages/agent-core/src/index.ts` через pnpm-симлинк `packages/agent-grok/node_modules/@claude-ui/agent-core`. Программа потребителя не содержит файл декларации, а `findReferencesAcross(loadNearest:true)` (его зовут и `usages.ts`, и `member-refs.ts`) берёт программы через `programsContaining`, то есть через containment построенной программы, — поэтому потребитель выпадает из fan-out. `complete=false` в ответе — из-за 5 несвязанных undiscovered-конфигов, причина неполноты названа неверно.
Оракул: копия снапшота с руками сделанными pnpm-ссылками (185 ссылок на `workspace:*`-зависимости) → 6 мест (+4 импорта); цена +1 с wall, RSS 821→868 МБ.

### Честная половина (минимум)
- Новое поле `unresolvedWorkspaceImports` в data `find_usages` и `member_usages`: `{package, sites, examples[file:line ≤3], total}` по каждому workspace-пакету, плюс `complete:false` и `!! LOWER BOUND`-нота. Нота называет спецификаторы и честно говорит, что инструментального пути нет («grep these specifiers»), — `install` на read-only снапшоте не вызвать.
- Отдельное поле, НЕ в `undiscoveredPrograms`: иначе повторится та же мисатрибуция. Это floor полноты поиска того же рода, что `undiscoveredPrograms`, и живёт в data op'а, а не в `Result.disclosures`: сомнение касается полноты обхода, а не идентичности цели.
- Триггер: любой статический импорт/реэкспорт, чьё имя bare-пакета = имя любого workspace-члена, если ни программа импортёра, ни ссылки его не резолвят. Срабатывает по всем программам, а не только по пакету цели: потребитель может прийти через реэкспорт другого члена (protocol → agent-core).
- Считается по `host.programs()`, которые fan-out этих двух op'ов уже построил (новых сборок нет — правило admission §5-L2); мемо на дисковую версию хоста. Резолв — `resolveSpecifier` (resolve-module.ts) с per-(dir|spec) мемо, как в `phantom-imports.ts`.
- Скоуп назван явно: только `find_usages` и `member_usages`. Остальные потребители floor (`importers_of`, bare-name `find_definition`, `find_unused_exports`, scan-fanout) — отдельная таска с `--created-by-session s-207994`.

### Полная половина — рекомендую: эмуляция workspace-ссылок в LS-хосте
- Новый модуль `src/plugins/ts/program/workspace-links.ts`:
  (a) `buildWorkspaceLinks(root)` — карта `<consumerPkgDir>/node_modules/<N>` → `<memberDir>` из кэшированного обхода репо (без нового repo-walk, §19);
  (b) обёртка хост-функций `fileExists`/`directoryExists`/`readFile`/`realpath`/`getDirectories` в `single.ts`: синтетический путь под ссылкой транслируется в реальный путь члена, а `realpath` отдаёт реальный путь члена — иначе файл грузится второй SourceFile под синтетическим путём и мерж не работает. `getScriptSnapshot` получает уже realpath'нутое имя.
  В `single.ts` — только проводка: файл уже ~330 строк.
- Резолвером остаётся TS (exports/conditions/types/main — его алгоритм). Хост лишь показывает ту раскладку ФС, которую создал бы пакетный менеджер. Второго оракула резолва нет (§4), риск лжи — в политике ссылок, а не в резолве.
- **Политика** (консервативная, недорезолв уходит в честную половину):
  - ссылка ставится, только если N — член workspace (globs из `pnpm-workspace.yaml` / `package.json workspaces`), N ≠ сам потребитель и N объявлен в `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies` package.json потребителя;
  - существующий на диске путь никогда не затеняется;
  - npm-хойстинг необъявленных (root `node_modules/N`) НЕ эмулируется;
  - программа с `preserveSymlinks:true` не эмулируется: TS оставил бы синтетический путь и получился бы дубль-SourceFile.
- Провенанс: строка в `status` «workspace links emulated: N (no node_modules)» — факт уровня репо.
- Свежесть: карта перестраивается на структурном reindex (изменился `package.json`). Тёплый TS переиспользует старые резолвы — это класс t-710809, ссылаюсь на него и тёплую корректность не заявляю; cold one-shot корректен.
- **Развилка: write path.** Хост общий, поэтому `rename_symbol`/`change_signature` и гейт §2.8 тоже видят эмулированный резолв. Выбор — включить: так мутация и чтение согласованы, а переименование в пакете переписывает потребителей так же, как на реальной установке. Альтернатива (эмуляция только для чтения) дала бы второй набор программ и расхождение read/write.
- Отвергнуто: синтезировать `compilerOptions.paths`. Это мутирует отображаемые options (ложь в `expand_type`/статусе) и обходит семантику `exports`/conditions.
- Цена/риск: размер программ становится как у реальной установки (замер выше: +6% RSS, +1 с), нового класса heap не появляется. Риск — неверная политика ссылки: менеджер слинковал бы иначе (версия из реестра вместо workspace) → резолв в source вместо реестрового пакета. Это смягчено требованием объявленной зависимости на члена и тем, что реальный путь, если он есть, побеждает.

### Скоуп-файлы
`src/plugins/ts/program/workspace-links.ts` (новый), `program/single.ts` + `ls-host.ts` (проводка), новый `src/plugins/ts/unresolved-workspace-imports.ts`, `api.ts`/`plugin.ts` (метод), `ops/find-usages.ts`, `ops/member-usages.ts` (+рендер нот), ARCHITECTURE §5-L2 (абзац multi-program), тесты.

### Проверка
- Герметичная фикстура (tmp-дир, реальная ФС), 4 случая:
  - объявленная `workspace:*`-зависимость → потребитель найден; оракул — та же фикстура с настоящим симлинком, множество мест должно совпасть;
  - необъявленный импорт → не слинкован, поле `unresolvedWorkspaceImports` есть;
  - настоящий симлинк → без override, поле молчит (негативный случай, без которого тест честной половины не может упасть);
  - `preserveSymlinks:true` → эмуляции нет, поле есть.
- Живой прогон: снапшот claude-ui (эмуляция) против `cui-linked` (настоящие ссылки) — выходы `find_usages systemText` и `member_usages RoleInfo.family` должны совпасть; time/RSS до и после — в файл, по одному прогону.
- Ревью кода: bug-reviewer (≤2 круга) + architecture-reviewer (1 круг).


Менеджер OK по 0d1d746: полная половина + write path включён + floor как запасной путь. Условия DONE: (1) claude-ui без node_modules → find_usages systemText = 6; entry → src находит, entry → несобранный dist → floor со спецификатором; (2) Disclosure через ledger (§3.6) на каждом ответе, чей резолв прошёл через эмулированную ссылку (find_usages, impact, impact_type_error, гейт мутации); (3) тест write path: move_file/rename внутри пакета, потребляемого через `@scope/pkg` — спецификаторы остаются `@scope/pkg/…`, правки не касаются эмулированного пути; (4) architecture-reviewer 1 круг.


## Поправки к плану (после plan-ревью и OK)
- Политика ссылок сужена до случаев, где результат известен без semver-решателя: pnpm — только `workspace:`; npm/yarn — `*` или точная версия члена. Реальный `node_modules/<name>` у потребителя или у любого предка до корня → ссылки нет. Имя, общее для двух членов, → ссылки нет.
- Единая видимость ссылок: `WorkspaceLinks.resolutionHost(options)` используют `resolveSpecifier` / `resolveModuleArg`, классификатор unused-exports, `refactor/imports/resolve.ts`, хосты capture (forward и reverse) и `extends` в `parseConfig`. При `preserveSymlinks` возвращается `ts.sys`, то есть то же, что видит такая программа.
- Тёплая свежесть: правка `package.json` / `pnpm-workspace.yaml` → `links.refresh()` (generation++) → на следующей сборке каждая программа резолвит заново через `hasInvalidatedResolutions` (`@internal` у `LanguageServiceHost`, но LS его читает). Пиннится тестом warm в `test/differential/workspace-links.test.ts`. Для этих сигналов закрывает и минимальный исход t-710809 (кроме lockfile).
- Провенанс — не строка в `status`, а envelope-claim `unsafe=resolution-matches-the-trees-own-tsc` через `discloseAtEnd` (ledger, вычисляется после op'а; продюсер в `warm()` ts-плагина). Его видят все LS-backed ответы, включая гейт мутаций. Гранулярность — уровень хоста: claim ставится, если хоть одна программа сессии шла через эмулированную ссылку. По-ответной точности нет — это сознательная переоценка в безопасную сторону.
- Мемо floor: ключ = generation ⊕ `projectVersion` ⊕ метки программ (ловит допуск программы через `ensureProgramFor` / `programs:`).

## Факты, вскрытые по ходу
- TS проверяет существование `<dir>/node_modules` (и `@scope`) ДО заглядывания внутрь. Без синтетических каталогов-предков (`isSyntheticDir`) эмуляция молча не работает: карта на 185 ссылок, `used` непуст, а программа файл не содержит. Первая версия на этом и споткнулась.
- Зеркальный `node_modules` в снапшотах claude-ui (`mirrorNodeModules`) сохраняет относительные pnpm-ссылки: все 236 относительные, ведут внутрь копии. Гипотеза «ссылка уводит за root» опровергнута. Реальная остаточная форма — зеркало с live-`base` расходится с ревизией снапшота; её закрывает эмуляция, потому что путь ссылки не существует.
- `move_file` внутри пакета, потребляемого через `@scope/pkg`, даёт ложный dangle в гейте и на НАСТОЯЩЕЙ установке → t-037355. Эмуляция делает его видимым на снапшотах. Тест пиннит «emulated ≡ installed», включая этот вердикт.
- `importers_of {module:'@scope/pkg'}` резолвит аргумент от корня репо → `resolved:false` и на установке → t-366658.
- Остальные потребители floor → t-715754.

## Не сделано / непонятно
- `coverage.ts` и `config-membership.ts` парсят tsconfig через `ts.sys`: `extends` из workspace-пакета, задающий `include`, там не увидит ссылку. Расхождение только в file-set membership, редкий случай; не чинил.
- Перепарс tsconfig при смене карты ссылок не делается (только при структурном reindex).


## Ревью кода
- bug-reviewer, круг 1 (515a155): 6 BLOCK, все исправлены в 5749868 —
  - `workspace:`-алиас;
  - TDZ при пакетном `extends` у primary;
  - новый `package.json` на тёплом хосте (сброс обхода);
  - режим резолва сайта в floor;
  - ключ сайта `file:offset`;
  - перепарс tsconfig при смене карты ссылок.
- architecture-reviewer, 1 круг (515a155): BLOCK = тот же TDZ; should-fix —
  - маркеры re-resolve на каждый LS-хост (rescue);
  - `unresolvedWorkspaceNote` через публичную поверхность `plugin.ts`;
  - формулировки §5-L2.

  Всё исправлено.
- bug-reviewer, круг 2 (5749868): 5 BLOCK. Это потолок кругов, исправлены без нового круга в 7b3b5c3:
  - конфликт спецификаций между полями зависимостей → ссылки нет;
  - `workspace:<range>` принимается только как `*`/`^`/`~` или тривиально выполнимый собственной версией члена;
  - корень pnpm — член workspace;
  - `realpath`/`readDirectory`/`directoryExists` в хосте разбора tsconfig (баг затрагивал и реальную установку: `extends` через симлинк терял `include`);
  - `import x = require()` в floor.

## Факты
- `ts.ParseConfigHost` без `realpath` оставляет путь extended-конфига под `node_modules`. Его `include` тогда считаются от синтетического каталога, и файлы теряются — и на эмуляции, и на настоящем симлинке. `ts.sys` канонизировал путь сам, поэтому до этого трека проблемы не было. Тест в `workspace-links-write.test.ts` падает при снятом `realpath` (проверено hold-правкой).


- bug-reviewer, доп. круг по слову менеджера (скоуп — 5 исправлений 7b3b5c3; 5749868..703966c): блокеров нет.
