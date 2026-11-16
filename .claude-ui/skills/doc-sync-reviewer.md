## codemaster — present-state docs

**In scope:** `ARCHITECTURE.md`, `src/README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `test/README.md`,
`.claude-ui/skills/*.md`, the backlog in `tasks/` (task-manager). **Out of scope (do NOT flag):**
`docs/about-ru.md` (a hand-written human narrative), `docs/wishlist.md` (the future, deliberately not
present-state).

Check in priority order:

1. **`§` references** resolve to a real ARCHITECTURE section.
2. **Contracts to check docs against:** `src/core/*`, `src/config/config.ts`, `src/ops/contracts.ts`,
   `src/core/plugin.ts` — the MCP tool surface; the fields of `Result` / `Fact` / `Span` /
   `Confidence` / `Provenance` / `FreshnessNote` / `ToolFailure` / `HandleRebind`; branded types; the
   `Plugin` interface + DAG; the op catalogue (§5-L3, §17); config sections.
3. **Tree ↔ reality.** The §15 tree and the src/README layer table ↔ `find src test -type f`: catch
   listed-but-absent and present-but-unlisted.
4. **Backlog fields** per `tasks/config.yml`; "in flight" pointers → a real `docs/spec-*.md`.
5. **`knip.jsonc`** — a dependency in `ignoreDependencies` as "declared ahead of use" that is already
   imported (time to remove), or the reverse.
