# codemaster MCP — Stress-Test Report

**Repo:** `amiro` (worktree `codemaster-stresstest`), HEAD `4c5e5e73` — tracked tree byte-clean after the run (все мутации откатаны).
**Прогон:** P1–P90, 17 опов × все фичи. Журнал: `findings-stresstest-journal.md` (строка на точку, durable). 7 feedback'ов подано в `~/.codemaster/feedback/inbox.md`.

> ## ⚠️ Сквозной конфаундер (читать первым)
>
> **100% вызовов** начинались с `!! daemon code behind source — reconnect MCP (running pre-edit behavior)` (pid 85230, v0.1.0). Как MCP-клиент я не могу «переподключить» демон, маркер неустраним.
>
> - **Read-опы доказанно надёжны** несмотря на маркер: я сверял с ground truth (P13 codemaster 270 ≈ grep 271; P11 38=38; P31 236=236; P82 sql 1737) — везде матч. Чтению верить можно.
> - **Mutation/typecheck findings ниже наблюдались под этим маркером.** Поэтому всё, что касается typecheck-gate (фантомный baseline 602 vs tsgo 0, недетерминизм gate), я подаю как **поведение запущенного демона, который сам себя пометил устаревшим** — мейнтейнеру нужно перепроверить против свежей сборки. Это не «codemaster-as-designed» с гарантией.
> - **НО** недетерминизм в пределах одной сессии (599↔602, P69) — настоящая находка независимо от staleness: устаревший-но-детерминированный бинарь не флипал бы.

---

## 1. Что понравилось — где codemaster реально победил grep/Read

- **Extension-aware import resolution (P11).** `importers_of @/components/ui/sheet` → 38 точно. Наивный `grep "@/components/ui/sheet"` = **0**, потому что импорты пишутся с `.tsx` (`@/components/ui/sheet.tsx`). Чистая семантическая победа.
- **css-module-aware мёртвые классы (P40) — сильнейший кейс.** `find_unused_scss_classes` пометил `savePayLaterBtn`, `footer` и т.д. в `AddSaleForm.module.scss` мёртвыми. Grep по имени класса «находил» по 1 рефу каждому — но это были **другой модуль** (`s.savePayLaterBtn` из `AddSalePaymentFooter.module.scss`) или **комментарий** (`footer` в JSDoc). codemaster прав, grep даёт false-positive в обе стороны. Плюс честный `partial` на computed-доступе (P43: `cn(s[variant])` → не врёт «definitely unused»).
- **Семантика поверх текста (P21).** `find_usages PaymentMethod text:true` → 3 semantic refs (decl/import/type) vs 11 text-only (`provenance=text`, `role=∅`). Grep смешал бы всё; codemaster доказал, что тип используется ровно 3 раза.
- **Алиасы и переименованный JSX (P84/P85).** `import {showErrorToast as toastErr}` → codemaster нашёл `toastErr(...)` call как ref на showErrorToast; `<Btn>` (renamed `Button`) пойман `role:jsx`. Grep по `showErrorToast(` / `<Button` оба слепы.
- **SQL post-filter — целый класс невозможного для grep (P24/P25/P26/P30/P75).** Anti-join «рендерит `<Button>`, но НЕ зовёт `showErrorToast`» = 153/154. Aggregate-ranking примитивов. INNER JOIN форм с `useAppForm` И `<Button>` = 4. Cross-repo join `formatCurrency` (cf2=6 / amiro=83). Self-consistency cross-check (unused ⊆ declared = 0 phantom). Это ядро ценности инструмента.
- **bulk `source` 20 целей за round-trip (P10):** 16 резолв (3 тела + 13 header-elided в terse), 4 unresolved с candidate-list — заменяет 20 Read'ов.
- **SymbolId chaining (P22/P38/P61):** encloser_id из `find_usages` → прямо в `source`/`expand_type`; после move старый id → **explicit rebound** с proof+confidence.
- **Honesty-contract в мутациях:** rename с aliased-import (P54) переписал `{getInitials as gi}`→`{initialsFrom as gi}`, сохранив локальный алиас; re-export `{formatCurrency}`→`{formatMoney as formatCurrency}` (P52) сохранил публичное имя; change_signature reorder semantics-preserving (P66).
- **dirtyOk — хирургичная точность (P87):** unrelated dirty файл → op применяется; dirty в **своём** touched-файле → `applied=false reason="touched files have uncommitted changes (...); commit/stash or pass dirtyOk"` с именем файла.

## 2. Что не понравилось — API / вывод / oversell

- **`fields:[…]` проекция не подключена (P28).** Заявлена в `status` concepts+columns, но отвергается и top-level (`expected array, received string`), и в args (`Unrecognized key: fields`). Единственный ❌ среди фич. Workaround: `sql:"SELECT col1,col2 FROM t"` (работает идеально). Либо вайрить, либо убрать из доков.
- **Cap прячет вердикт мутаций (P52/P53/P64).** Большой rename/move сначала печатает unified diff, а `typecheck:`/`touched:` summary — ПОСЛЕ; на 24-файловом ренейме diff упирается в `!! OUTPUT CAPPED@~50k` и summary не виден. На малых (11 файлов) — влезает. Решение: печатать summary ПЕРЕД diff, либо `summaryOnly`-режим. У мутирующих опов нет `sql`, поэтому ужать вывод нечем.
- **Fuzzy слабее заявленного «Cmd+T» (P5, docs-oversell, не ложь).** `frmtCurncy` → 0, хотя это валидная subsequence `formatCurrency` (f-r-m-t-C-u-r-…-n-c-y по порядку) — реальный Cmd+T матчит. codemaster честно вернул пусто (не выдумал), но «editor Cmd+T style» в доке завышено.
- **`NumberInput` ambiguity печатает две decl как одинаковый `:41` (P10/P25)** без колонки — это `const`+named-fn-expr на одной строке, но выглядит как ошибочный дубль. Добавить col.
- **`source` ≤20, а ambiguous имена едят слоты** под `unresolved` — приходится до-резолвить координатой/id.

## 3. Где мешал / тормозил — фрикция (>1 попытки)

- **Cross-repo относительные пути (P1).** Spec'овый `../customer-frontend-v2` из worktree молча дал `workspace: none resolved` (резолв относительно cwd worktree, не main-checkout). Нужен абсолютный/правильный rel. Молчаливый none вместо подсказки — фрикция (2 попытки).
- **`sql` + non-tabular op в batch (P23).** `find_definition` под `sql` → весь batch падает `op has no table`, хотя SELECT трогал только tabular-алиас. Пришлось убирать sql. Аналогично rename/move/codemod не принимают sql (нечем ужать вывод).
- **codemod `paths` глоб не работает (P71, 3 попытки).** `["src/features/sales/**"]` и `["**/*.ts"]` → **0 матчей молча**; только литеральный путь файла сработал (4 матча). При том `pathInclude` в scss/usages-опах глобы принимает. Тихий 0-match читается как «нет совпадений».
- **P34/P64:** ambiguous `ProblemDetail` → FAIL (нужна координата); extract nested-имени тихо ретаргетит на enclosing top-level (98k diff, вердикт под cap).

## 4. Где обманывал — ⓋGT-сверки (ядро отчёта)

**Сначала честно: настоящей «ложь = заявил X, GT показал не-X» в read-опах я НЕ нашёл.** Проверено независимо (grep/sed/python/tsgo):

- P13 Button 270 refs ≈ grep 271 (off-by-1) — **codemaster точен, мой первый grep (58) был неверен** (мисс multiline `<Button\n`).
- P11 sheet importers 38=38; P31 errors.codes 236=236; P40 каждый «unused» класс реально мёртв (cross-module/комментарии); P48 динамический `i18n.t(\`errors.codes.${code}\`)`реально демоутит (error-handler.ts:49,64); P82 «producers uncapped» = 1737 > 500 display — **claim verified TRUE**; P50 alias-blindspot реально (файл проиндексирован`reindexed 3`, но `tr()` не матчится — точно как задокументировано).
- Анкеры spec'а (Button ~429, showErrorToast ~123) **устарели** — codemaster совпал с реальностью, не spec. Это не ложь codemaster.

**Единственная настоящая децепция — typecheck-gate репортит несуществующие ошибки:**

- **P58/P63/P69-dryrun: `clean=false / introduced(N)` для правок, вводящих НОЛЬ реальных ошибок** (tsgo=0), причём в **нетронутых** файлах. P58: move папки → 11 «introduced», но `preExisting` упал ровно 602→591 — арифметика **602=591+11** доказывает, что это те же pre-existing ошибки, переехавшие с файлом (delta keyed by path). P63/P69: тривиальная правка (`size={14}→16`, extract const) выплёскивает 3 фантомные `DropdownMenu children` ошибки в `MultiSelectField`/`InlinePicker`, которых правка не касалась. **Юзер, доверившись `clean=false`, бросил бы безопасный рефактор.** Это сильнейший §4-айтем.

**Honest-but-unexpected (НЕ децепция — codemaster пометил честно):**

- P17 (роли синтаксические, не store-field) — честно. P76 (cross-repo id → rebound с `confidence=partial` + "structural continuity not proven") — честно флагнуто. P79 (`COLOR_CLASS[expr]` → `certain`, т.к. символ статичен) — корректно. P5 (вернул пусто, не выдумал). Ни одно не выдаётся за факт.

## 5. Где ломался — FAIL'ы, баги, краши

- **Недетерминизм typecheck-gate (P69, headline-баг).** Идентичный codemod: dry-run → `clean=false, introduced(3), preExisting=599`; тут же apply → `clean=true, preExisting=602, applied=true`. Вердикт gate флипает между проходами → безопасная правка то отклоняется (P58/P63), то проходит. **Реальная находка вне зависимости от staleness** (детерминированный бинарь не флипал бы). Фантомный baseline ~600 vs `tsgo`=0 указывает на не-загруженный project tsconfig (`allowImportingTsExtensions` и пр.).
- **codemod `$$$` метавар — malformed output (P70).** `cn($$$A)`→`clsx($$$A)` на `cn(badgeVariants({variant}), className)` дал `clsx(badgeVariants({variant}), ,, className)` — лишние пустые запятые, невалидный синтаксис. gate/prettier ловит (не пишет), но сам трансформ сломан на ровно том кейсе, что рекламирует дока.
- **codemod `paths`-глоб (P71)** — `**` молча не резолвится (см. §3).
- **Корректные FAIL'ы (не баги, образцовые):** P32 (`DELETE FROM t` → "only read-only SELECT" + список таблиц), P59 (move на существующий dest → `destination already exists`), P67/P68 (change_signature консервативно отказал на JSX-use / omitted-trailing-args с перечислением нарушителей), P80 (rename несущ. символа → FAIL+fallback), P55/P83 (rename-коллизия/reserved-word → apply отклонён pre-write, git byte-clean).

**Важно про rollback:** все провалы apply — это **pre-write refusal** (`applied=false`, `rollback.performed=false`). Истинный byte-exact write-then-rollback (`performed=true`) **ни разу не наблюдался** — gate тайпчекит ДО записи. Refusal-путь и apply-success-путь верифицированы; write-then-rollback — нет.

## 6. Per-op verdict table

| Op                       | Вызывался | ≈раз | Надёжность         | Заметка                                                                                  |
| ------------------------ | --------- | ---- | ------------------ | ---------------------------------------------------------------------------------------- |
| search_symbol            | ✅        | 8+   | высокая            | fuzzy слабее Cmd+T (P5); honest CAP/truncation                                           |
| find_definition          | ✅        | 8+   | высокая            | ambiguity→candidate list (P7/P34/P78); coord-адресация (P9)                              |
| find_usages              | ✅        | 20+  | **высокая, точна** | роли/groupBy/text/filter/collapseImports все ок; GT-матч (P13)                           |
| expand_type              | ✅        | 6    | высокая            | union/enum/members/memberLimit-overflow честны; AppForm=any (P33)                        |
| source                   | ✅        | 5    | высокая            | 20-bulk, terse-elide, unresolved-candidates                                              |
| importers_of             | ✅        | 5    | **высокая**        | extension-aware (semantic win P11)                                                       |
| scss_classes             | ✅        | 2    | высокая            | координаты точны                                                                         |
| find_unused_scss_classes | ✅        | 5    | **высокая**        | css-module-aware, partial-демоут честен (P40/P43)                                        |
| i18n_lookup              | ✅        | 8    | высокая            | key/prefix/value(substring+exact); alias-blindspot задокумент.                           |
| find_unused_i18n_keys    | ✅        | 4    | высокая            | all-partial при динамике, честно                                                         |
| find_missing_i18n_keys   | ✅        | 2    | высокая            | dynamic отделён как unresolvable                                                         |
| rename_symbol            | ✅        | 9    | средняя\*          | механика отлична (алиасы/re-export); \*gate-baseline шумный                              |
| move_file                | ✅        | 6    | средняя\*          | scss-carry/git-mv/import-rewrite ✅; \*false-introduced на pre-existing (P58)            |
| extract_symbol           | ✅        | 6    | средняя\*          | css-copy-safe отличен; \*gate over-report (P63), nested→enclosing retarget (P64)         |
| change_signature         | ✅        | 4    | **высокая**        | removeParam/reorder + консервативные отказы образцовы                                    |
| codemod                  | ✅        | 7    | **низкая**         | AST-precision ✅; но `$$$` malformed (P70), `paths`-глоб (P71), gate-недетерминизм (P69) |
| feedback                 | ✅        | 7    | высокая            | `recorded=true at=…` каждый раз                                                          |

`*средняя` = сама трансформация корректна; ненадёжен **apply-gate** (фантомный/недетерминированный typecheck baseline под daemon-staleness).

## 7. Coverage matrix

**17 опов:** все ✅ (таблица §6).
**Фичи:**

- batch return:all ✅ (P23/P74) · sql anti-join ✅ (P24) · sql aggregate ✅ (P25/P31) · sql join ✅ (P26/P30/P75) · sql NOT-IN на partial+warning ✅ (P27) · sql read-only enforcement ✅ (P32)
- cross-repo root ✅ (P1/P73/P74/P75/P76) · mixed-root batch ✅ (P74) · cross-root sql join ✅ (P75)
- verbosity terse/normal/full ✅ (P8) · format:json ✅ (P29/P51) · **fields ❌ (P28 — не подключён к схеме; workaround = sql-проекция)**
- SymbolId chaining ✅ (P22/P38/P61) · dry-run ✅ (везде) · apply ✅ (P53/P57/P62/P66/P69/P87) · **apply rollback: refusal-путь ✅ (P55/P58/P72/P83), write-then-rollback `performed:true` НЕ наблюдался** (gate pre-write)
- freshness recheck ✅ (P50/P57/P60/P86 reindexed) · feedback ✅ (7 шт., P89)
- honesty-contract: CAP ✅ (P77) · unresolved/candidates ✅ (P78) · partial ✅ (P40/P43/P48/P76) · FAIL+fallback ✅ (P80) · bad-args `valid:{}` ✅ (P52/P81) · `dynamic` confidence — **частично**: отработан в scss(`dynamicModules` P41)/i18n(P48), но на TS-плагине форсить не удалось (P79 — корректный `certain`).

Единственный ❌ — `fields`-dial (обоснован: не в схеме op'а, sql-проекция замещает).

## 8. Итоговый вердикт

**Заменил бы grep в ежедневной работе — для ЧТЕНИЯ: да, уверенно.** Семантические запросы (usages по ролям, importers с extension/alias-aware, мёртвые scss css-module-aware, anti-join/aggregate через sql, cross-repo) — там, где grep даёт false-positive/negative, codemaster доказанно точен и проверяем (proof-carrying spans, честный CAP/partial/unresolved). Read-слой выдержал каждую ⓋGT-сверку; настоящей лжи в чтении я не нашёл (искал в P5/P7/P11/P13/P21/P40/P48/P50/P76/P82 — везде честно или точно).

**Доверять:** все read/search/type/scss/i18n опы; sql-post-filter; rename/move/extract/change_signature **механику** (diff'ы корректны); honesty-маркеры (partial/unresolved/rebound/CAP — не врут).

**Перепроверять (своим tsc/git):** **apply-gate мутаций.** Его typecheck-baseline под текущим (self-reported-stale) демоном шумный (~600 фантомных ошибок vs `tsgo`=0) и **недетерминированный** (P69) — безопасные правки то блокируются, то проходят. Перед доверием `clean=true/false` гоняй проектный typecheck. И **codemod**: `$$$`-метавар и `paths`-глоб имеют конкретные баги — для structural rewrite пока проверяй вывод глазами + проектным тайпчеком.

**Самый серьёзный системный риск** — неустранимый `daemon code behind source` на 100% вызовов: либо демон реально отстаёт от исходника (тогда все мутационные findings нужно перепроверить против свежей сборки), либо false-positive (тогда он подрывает доверие зря). В любом случае — починить первым.

Итого: **codemaster — сильная замена grep для понимания кода и мощный sql-слой поверх; для применения мутаций — отличная dry-run/механика, но apply-gate требует внешней верификации, пока typecheck-baseline и daemon-staleness не вылечены.**
