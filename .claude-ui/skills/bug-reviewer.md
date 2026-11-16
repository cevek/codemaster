## codemaster — the bug classes that break trust (ARCHITECTURE §3)

1. **Stale / inconsistent.** A result with no read-time freshness check (§3.5/§8); a plugin-internal
   cache trusted across a `git HEAD` / mtime drift; a stale `SymbolId` silently rebound to whatever now
   sits at the path instead of a proof-carrying rebind on `Result.handle` (or `gone`); a handle bound to
   something other than its plugin's per-file stamp (needless invalidation by another file's edit).
2. **Wrong proofs.** `Span.text` ≠ the live source at its range; `file:line` off by one (1-based
   line/col vs 0-based offset); the wrong file.
3. **Misidentification.** `find_usages` / `rename_symbol` hits a same-named but different symbol; a
   symbol-anchored edit fired from an ast-grep shape instead of an LS resolve; a missed aliased import
   (`import {X as Y}` … `<Y/>`); a `SymbolId` routed to the wrong plugin (bad or unknown prefix).
4. **Completeness lies.** Silent truncation; partial served as complete; a `dynamic` hop bridged
   without a flag; a cross-plugin op composing several `Result<T>` and dropping someone's
   `FreshnessNote` / `ToolFailure`; an empty scan reported as an empty result, or a finished empty walk
   refused (CONTRIBUTING "Prime directive").

Daemon specifics: an op ↔ watcher or mutating-op ↔ reindex race, shared mutable state between
concurrent requests; a long SYNCHRONOUS call on the main thread (LS, typecheck, `JSON.parse/stringify`
of a large payload, `execSync`, bulk parse) blocking the orchestrator loop — heavy work belongs in the
workspace engine (§2); an unwrapped external call (LS / git / ast-grep / prettier / fs) letting an
exception escape to the agent instead of a `ToolFailure`; resource leaks around LRU eviction (LS /
watcher / file handle); `noUncheckedIndexedAccess` holes and proof-span offset drift on non-UTF-8 /
CRLF / symlinks.
