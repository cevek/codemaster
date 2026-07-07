## Классы багов codemaster (что ломает trust — читай ARCHITECTURE §3)

1. **Stale / inconsistent.** Результат без read-time freshness-проверки (§3.5/§8); внутренний кэш
   плагина, которому верят при дрейфе `git HEAD`/mtime; stale-`SymbolId` молча ребайндится на то, что
   теперь занимает путь, вместо proof-carrying rebind на `Result.handle` (или `gone`); handle привязан
   не к per-file-стампу своего плагина (лишняя инвалидация от чужой правки).
2. **Wrong proofs.** `Span.text` ≠ живой источник в его диапазоне; `file:line` off-by-one (1-based
   line/col vs 0-based offset); не тот файл.
3. **Мисидентификация.** `find_usages`/`rename_symbol` бьёт same-name-но-другой символ; символ-anchored
   правка сработала на ast-grep-shape вместо резолва через LS; пропущен алиас-импорт
   (`import {X as Y}` … `<Y/>`); `SymbolId` уехал не в тот плагин (кривой/неизвестный префикс).
4. **Completeness-ложь.** Silent-truncation; partial выдан за complete; `dynamic`-хоп смостили без
   флага; кросс-плагин op компонует несколько `Result<T>` и теряет чей-то `FreshnessNote`/`ToolFailure`.

Плюс общее для демона: **async/concurrency** — floating/misused promise, гонка op↔watcher или
mutating-op↔reindex, shared mutable state между конкурентными запросами, долгий СИНХРОННЫЙ вызов на
главном треде (LS, typecheck, `JSON.parse/stringify` большого payload, `execSync`, bulk-parse) блокирует
loop оркестратора — тяжёлое в workspace-engine off-orchestrator (§2); **undefined/edge** —
`noUncheckedIndexedAccess`-дыры, пустой массив, zero-length span, first/last, off-by-one; **error-paths**
— необёрнутый внешний вызов (LS/git/ast-grep/prettier/fs), из-за которого исключение утекает агенту
вместо `ToolFailure`; **resource leaks** — LS/watcher/file-handle вокруг LRU-eviction; **path/encoding**
— posix vs windows separators, symlink, non-UTF-8, CRLF-сдвиг офсетов.
