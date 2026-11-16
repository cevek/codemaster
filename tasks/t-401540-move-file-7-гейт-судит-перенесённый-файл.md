---
id: t-401540
title: 'move_file: §7-гейт судит перенесённый файл чужой программой (tsconfig.base.json / корневой) → ложные introduced-ошибки, apply отклонён'
status: done
priority: high
parent: t-982648
tags:
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: bug
complexity: M
area: ts-refactor
audience: external
evidence: repro
author: mb-ce356acc
assignee: mi-71ed3970
created: '2026-11-16T09:41:51.479Z'
---
## Симптом
claude-ui (pnpm-монорепо):
1. `move_file apps/web/src/components/SortableProjects.tsx → …/sidebar/SortableProjects.tsx` — гейт насчитал 11 introduced ("--jsx is not set", "Cannot find name 'document'") из программ `tsconfig.json` / `tsconfig.base.json`, которые apps/web/src не включают.
2. `move_file apps/server/src/sessions/userWords.ts → sessions/api/userWords.ts` — 20 ошибок 'not under rootDir apps/server' (TS6059) по файлам packages/protocol из программы `tsconfig.base.json/apps/server`.
Ручной перенос в обоих случаях проходит `pnpm typecheck`.

## Гипотеза
Правило «program affected, если его glob владел бы файлом» (ARCHITECTURE §5-L2, writes fan out) втягивает base-конфиг, который реальный typecheck проекта не гоняет; либо base-программа baseline/overlay несимметрична по новому пути.

## Минимальный исход
Ошибки, которые гейт приписывает программе, не включающей ни исходный, ни целевой путь по своему include, не считаются introduced (или гейт не включает такую программу). Тест: двухпакетная фикстура с base-конфигом без jsx.

## Источник
Inbox: «move_file typecheck gate judges a moved .tsx by tsconfig.base.json…» (2026-11-05T17:37), «move_file refuses on spurious rootDir errors…» (2026-11-15T21:40).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.


## Разбор (репро на claude-ui e4f930a2, копия /tmp/t401540-cui, с node_modules через `pnpm install --offline`)

Исходные файлы симптома уехали; аналоги: `apps/web/src/components/HostName.tsx → components/sidebar/HostName.tsx` (17 introduced, гейт по 4 программам) и `apps/server/src/sessions/countBackfill.ts → sessions/api/countBackfill.ts` (31 introduced, TS6059). Атрибуция по программам снята временной пометкой `[label]` в `gateAcross`:

- **web-перенос: 7 ошибок от `tsconfig.base.json`, 10 от `apps/web/tsconfig.scripts.json`.**
  - Причина A (гипотеза таски, верна частично): `tsconfig.base.json` лежит рядом с primary `tsconfig.json` → грузится как sibling (`discoverSiblingConfigs`, источник 1). В нём нет `files`/`include` → дефолтный `**/*` → `mayContain` истинно для любого файла репо → программа попадает в `affected` и судит `.tsx` без `jsx`/DOM. Реальный `pnpm typecheck` её не гоняет: это только цель `extends`.
  - Причина B (новая, в гипотезе нет): `apps/web/tsconfig.scripts.json` (include `scripts/**`, `vite.config.ts`) держит импортёров (`AppShell.tsx`, `settings/*.tsx`) ТРАНЗИТИВНО (`containsFile`=true, `mayContain`=false). `claimedBy` отдаёт ей переписанных импортёров, но не dest: его глобом владеют другие программы, а запасной вариант «primary берёт ничейное» не срабатывает. Получаем `Cannot find module './sidebar/HostName.tsx'` и каскад `unknown` в `McpSection.tsx:511-517`. После настоящего переноса программа дотянется до dest по импорту; overlay этого не моделирует.
- **server-перенос: все 31 ошибки — от `apps/server/tsconfig.json`, base не участвует** (проверено исключением base из discovery: результат тот же).
  - Причина C (гейт ПРАВ, баг в rewrite): `rewriteImports` переписывает СОБСТВЕННЫЙ bare-импорт перенесённого файла `'@claude-ui/protocol'` в `'../../../../../packages/protocol/src/index'`. В `emitSpecifier` не-относительный спецификатор, которого нет в alias-карте (`paths`/`baseUrl`), падает в relative-фолбэк. TS резолвит workspace-пакет через симлинк в `packages/protocol` (realpath), а это нода дерева. Относительный путь делает файлы protocol не-внешними → настоящая TS6059 под `rootDir: "."`. Человек при ручном переносе оставил bare-спецификатор, поэтому `pnpm typecheck` зелёный.
- Без node_modules картина зашумлена отсутствием зависимостей. Ошибки про пути dest «Cannot find module '@claude-ui/protocol'» там из-за C плюс отсутствующих пакетов; это не отдельный дефект.

Опровергнуто: «base-программа baseline/overlay несимметрична по новому пути». Для base dest глобится (`m=true`) и overlay-ится симметрично; лжёт не симметрия, а сам факт, что base судит.

## План

Скоуп (три причины, у всех один симптом: ложный отказ apply на корректном переносе; приёмка требует все три):

1. **C — `src/plugins/ts/refactor/imports/rewrite.ts` (+ `emit.ts`).** Правило: не-относительный спецификатор (bare-пакет или alias) у НЕперенесённой цели НЕ переписывается, даже когда переехал импортёр. Такой спецификатор не зависит от расположения импортёра (§2.2 «alias меняется, только когда двигается ЦЕЛЬ»). Запись в `rewrites` остаётся с `newSpec` = исходный текст: capture-гейт по-прежнему проверяет, что из нового места спецификатор резолвится в ту же цель (перенос в другой пакет с другой копией зависимости не пройдёт молча). Перенесённая цель с bare-спецификатором ведёт себя как раньше.
2. **B — `src/plugins/ts/program-gate.ts`, `gate-membership.ts`, `GateScope` (+ проводка в `ops/refactor-plan-apply.ts`).** `GateScope.moves?: {from,to,kind}[]` (берётся из `plan.moves`). `claimedBy` дополнительно: путь X под dest переноса достаётся программе, которая `containsFile` соответствующий source (file — точная пара, dir — по префиксу). «Любой removed ⇒ все новые файлы» НЕ берём: это ломает правило симметрии 2 на переносе папки. `overlayClaims` идёт через тот же `claimedBy`, значит видит те же пары; `claimDivergence` на этом переносе становится пустым. `program-gate.ts` уже 336 строк, поэтому выношу membership (`owns`/`affected`/`claimedBy`) в отдельный файл.
3. **A — base-конфиг вне write-гейта** (`affected` + источник флага на `SingleProgram`/`program/`). Программа исключается из `affected`, когда ВСЕ ноги истинны: (i) ни у неё, ни в её цепочке `extends` нет `files`/`include` (действует дефолтный глоб); (ii) её конфиг — цель `extends` другой загруженной программы (по разбору TS: `extendedConfigCache`/`extendedSourceFiles`, массив и пакет учитываются; на установленном TS 6.0.3 проверено, что `extendedSourceFiles` заполнен); (iii) это не primary. Флаг считается один раз на `loadFileList` (не на каждый вызов гейта, §19). Исключение раскрывается нотой гейта: «skipped N extends-only base config(s): …», молча не выкидывается. Чтения (`find_usages`, дедкод, undiscovered-набор) не трогаю: discovery-вариант шире брифа, он сдвигает undiscovered и покрытие файлов, которыми владеет только base.
   Почему §5-L2 не ослаблен: dest под расходящимися опциями реальной программы-владельца по-прежнему в гейте (её нога (i) ложна). Файлом, которым не владеет никакая оставшаяся программа, владеет primary через `claimedBy`, поэтому каждый правленый файл проверяет хотя бы одна реальная программа. Остаточный риск для файлов, которыми владеет только base, — отказ, а не ложный clean. Тесты `move-cross-program.test.ts` (ORACLE dest-config, «disjoint dest program … refuses» для move и extract, «NO tsconfig glob owns») остаются зелёными без правок.
4. **Доки:** ARCHITECTURE §5-L2 «Writes fan out» — дописать пары move→dest и исключение extends-only base, в том же коммите.

Проверка:
- Тесты (inline-VFS, оракул — холодный `ts.Program` по каждому конфигу):
  - C: workspace-пакет за симлинком (паттерн `ls-host-symlink.test.ts`), переносим импортёр в подпапку. Ассерты: after-текст сохраняет bare-спецификатор, холодная программа dest-пакета чистая, apply проходит.
  - B: программа, которая держит source транзитивно, получает dest, перенос чистый; страж: программа, которая не держит source и не глобит dest, dest НЕ получает.
  - A: двухпакетная фикстура, base без `include` и без `jsx`, перенос `.tsx` чистый. На каждую ногу фикстура, где решает только она: base с `include` остаётся в гейте; конфиг без `include`, который никто не extends, остаётся в гейте; primary-base остаётся. Ассерт ноты skipped.
- Живая проверка (копия claude-ui, тяжёлое по одному, вывод в файл): сначала доказать, что оракул краснеет. Текущий багованный дифф C руками в copy2 → `tsc` по `apps/server` даёт TS6059. Затем на исправленном дереве `move_file --apply` обоих переносов в свежих копиях → `pnpm --filter ./apps/server typecheck`, `pnpm --filter ./apps/web typecheck`, корневой `tsc -p tsconfig.json`, все зелёные. У проекта TS 7.0.2, у codemaster 6.0.3: расхождение называю, если всплывёт.
- Гейт: `npm run fix-and-check` + затронутые тесты по путям (`move-cross-program`, `move-file`, `capture-safety`, `post-apply-verify`, `drift-fence-scope`, `program-gate-*`, `transaction-cross-program`, новые).

Развилки:
- A на уровне discovery (не грузить base вообще) против исключения из write-гейта. Беру гейт: меньше радиус, чтения не меняются.
- B: пары из `plan.moves` против «любой removed». Беру пары: точнее и не ломает симметрию.
- C: «не переписывать не-относительный спецификатор у неперенесённой цели» против «вычислить пакетный спецификатор». Беру первое: оно и есть ручной перенос.

Ревьюверы на код: bug-reviewer (до 2 кругов) + architecture-reviewer (1 круг: экспортный контракт `GateScope` между ops и plugins, вынос модуля из `program-gate.ts`).

Потребители шва B: у `extract_symbol`/`move_symbol` в новый файл та же транзитивная асимметрия (у нового файла нет source-пары в `moves`) → t-959725. Primary, который сам pure-base (корневой `tsconfig.json` без include, его extends пакеты) → t-041300. Подписи программ в introduced → t-057191.


### Поправка к плану (по plan-ревью 442f0fd и e2e-фикстуре)
- **B шире, чем «dest в overlay».** `getScriptFileNames` делал КАЖДЫЙ ключ overlay корнем программы. Транзитивно держимый файл (переписанный импортёр, dest по source-паре) становился root, переставал быть внешним и под `rootDir` давал TS6059 (видно на фикстуре `@w/core` + `rootDir: "."`). Эта асимметрия существовала и до фикса. Решение: `OverlayEntry.root?: false`. `claimOf` (program-ownership.ts) отдаёт `root`, когда глоб программы трекает или затрекал бы путь, и primary-фолбэк ничейного пути; `reached`, когда программа держит путь или source только по импорту. В baseline такой файл тоже не root, так что baseline и overlay совпадают.
- **A, [BLOCK] ревьювера:** три ноги не отличают base от самостоятельного default-glob конфига (`packages/lib/tsconfig.json` без include, который кто-то extends). Добавлены ноги: имя не `tsconfig.json` (его берёт `tsc` в своей папке), не цель `references` (`tsc -b`), не назван скриптом `package.json` рядом с ним. Цепочка `extends` берётся из свежего `extendedConfigCache` (8-й аргумент `parseJsonConfigFileContent`) и пересчитывается на каждом `loadFileList`.
- **C, [BLOCK] ревьювера:** «любой не-относительный» менял поведение для `baseUrl`/`paths`-алиасов, у которых цель зависит от опций dest-программы. Сужено: спецификатор остаётся как есть, только если TS разрешил его через `node_modules` (`isExternalLibraryImport`), то есть это пакет, в том числе workspace-пакет через симлинк. Алиасы идут прежним путём emit.
- **Кэш, [BLOCK] ревьювера:** `scope.moves` входит в ключ результата гейта.
- t-037355 (трек t-403708: перенос внутри workspace-пакета, который потребляют через `@scope/pkg`) — та же форма B, покрыта e2e-тестом `move_file inside a workspace package`.


## Проверка
- Оракул краснеет: старый дифф C руками в копии claude-ui даёт `pnpm --filter ./apps/server typecheck` exit 1, 31× TS6059, столько же, сколько насчитал гейт.
- На исправленном дереве `move_file --apply` обоих переносов (HostName.tsx → sidebar/, countBackfill.ts → sessions/api/) проходит в свежей копии с нотой «skipped tsconfig.base.json». После этого `pnpm --filter ./apps/server typecheck`, `pnpm --filter ./apps/web typecheck` и корневой `tsc -p tsconfig.json` (TS 7.0.2 проекта) дают exit 0. Bare-спецификатор `@claude-ui/protocol` сохранён.
- Каждый e2e в `test/e2e/move-workspace-gate.test.ts` краснеет на откате своего фикса: C, source-пара B, root-ness B, предикат A. Ключ кэша с `moves` краснеет в `program-gate-cache.test.ts`.
- Последствие root-ness: unimported `declare global`, перенесённый вне всех glob, больше не рутуется primary-фолбэком. Гейт отказывает ДО записи, а не откатом после. Прежний e2e на расширенный рекчек переписан на отказ; e2e-покрытие пути `claimDivergence` → откат потеряно → t-147277.


## Ревью кода, круг 1 (cc9aec7)
- architecture и bug, [BLOCK] — `runByScript` не инвалидировался при правке `package.json`. Теперь `reindex` с любым из `scriptManifests` пересчитывает флаг без re-glob; e2e warm→правка scripts→гейт.
- bug, [BLOCK] — скрипт корневого `package.json` (`tsc -p packages/lib/tsconfig.build.json`) не учитывался. Теперь читаются manifests от папки конфига до корня воркспейса; совпадение по basename консервативно: ложное совпадение только оставляет конфиг в гейте.
- bug, [BLOCK] — оставленный bare-спецификатор capture проверял под опциями primary, и `paths` dest-программы мог тихо перенаправить имя. Теперь спецификатор остаётся, только если КАЖДАЯ программа, чей glob владеет новым путём, разрешает его в тот же файл (`resolvesSameUnderOwners`); иначе работает прежний emit. e2e с shadow-`paths`.
- Живая проверка повторена на свежей копии claude-ui: оба переноса применяются, typecheck server/web/root даёт exit 0.


## Ревью кода, круг 2 (0833020) — потолок bug-reviewer, фикс без нового круга
- [BLOCK] Конфиг, который запускается не из `package.json`-строки (shell-скрипт `scripts/typecheck.sh` → `tsc -p tsconfig.build.json`), классифицировался как base и молча выпадал из гейта: ложный clean. По репо «конфиг никто не запускает» НЕ доказуемо, ни одна эвристика поиска команд этого не гарантирует. Опровергнутая ветка решения: «исключить base из гейта». Решение: base судится ADVISORY. Программа сэмплируется как любая другая, но в `GateResult.advisory`; её introduced-ошибки (с тем же remap перенесённых путей) перечислены в ноте с местами (`file:line message`, cap 5) и apply не отклоняют. Ноги предиката остаются: они сужают круг advisory-программ, а ошибка классификации теперь даёт раскрытое предупреждение, а не тишину. Цена: base-программа снова строится и проверяется, как до фикса.
- [BLOCK] `resolvesSameUnderOwners` спрашивал и base-программу, так что её `paths` решали, переписывать ли спецификатор (ложный отказ). Теперь base из владельцев исключён; e2e с shadow-`paths` в base.
- Живая проверка на свежей копии claude-ui: переносы применяются; на web-переносе нота advisory показывает те же 7 ошибок `tsconfig.base.json`, что в разборе; typecheck server/web/root даёт exit 0.


## Доп. круг bug-ревью (по слову менеджера, 0833020..46d1e77)
- [BLOCK] advisory-диагностики всех base-программ сливались в один multiset: ошибка, исчезнувшая под одним base и появившаяся под другим (та же строка), гасила сама себя, и нота писала «no error introduced». Теперь `GateResult.advisory` хранится по программе, а diff с remap выполняется для каждой отдельно; юнит `gate-coverage-notes.test.ts` краснеет на слитом multiset.
- Тест транзакции формы B (две цепочки move внутри workspace-пакета, `transaction`) краснеет без source-пары: подтверждено, что `TxnCompose` проводит `moves` в гейт.

## Слияние с фичеветкой (origin/mcp-session-economy 0bb59a0, трек t-403708 — эмуляция workspace-ссылок)
- Конфликты: `program/single.ts` (их `links`/`ReresolvingHost`) и `refactor/imports/resolve.ts` (их `host.workspaceLinks().resolutionHost`). Мои правки перенесены поверх их версии; `parseConfigFile` получает их `ParseConfigHost`; `resolveSpecifier` и `resolvesSameUnderOwners` резолвят через `resolutionHost`.
- Правило C не зависит от node_modules: под эмуляцией (pnpm-workspace + `workspace:*`, без симлинка) спецификатор так же остаётся, e2e `without node_modules…`.
