# Task B — Agent-surface ergonomics: status brief + dedup, find_unused_exports

> Self-contained task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §11 (lean MCP
> surface) + §12 (output), call codemaster `status` (dogfood it; don't grep).

## Why

A stress-test review: `status` is the heaviest single output in the agent loop, re-emits the full
op catalogue on every call, and its trailing `>` GUIDANCE block **duplicates the MCP `initialize`
instructions verbatim** (printed every status). And there's an obvious missing read-op:
`find_unused_exports` (the scss/i18n unused-ops exist; the TS one doesn't, though the infra does).

## Scope — IN

1. **`status {brief:true}`** — daemon header + warm roots + plugins line + per-op NAME + the one-line
   summary + freshness only; NO full arg schemas, NO per-op notes, NO concepts dump. Keep default
   `status` FULL (back-compat + the golden). Add **`status {op:"<name>"}`** to fetch one op's full
   schema+notes on demand.
2. **Drop the duplicated GUIDANCE tail** — the 4 `>` lines in `status` (`GUIDANCE` in
   `orchestrator.ts`) duplicate `SERVER_INSTRUCTIONS` (`mcp/schema.ts`, shipped once per session in
   the MCP `initialize` response). Remove them from status (or collapse to one line). Honest: the
   steer already reaches the agent once at connect.
3. **`find_unused_exports`** — a new read op: TS exports with no importer/usage anywhere (semantic,
   via the LS + the same machinery behind `importers_of`/`find_usages`). MIRROR the honesty of
   `find_unused_scss_classes`/`find_unused_i18n_keys`: an export reached only via a barrel re-export
   or dynamic `import()` demotes to `partial` ("could not prove dead"), NEVER "definitely unused".
   pathInclude/pathExclude scoping + explicit CAP like the siblings. Register in `builtins.ts`,
   self-describe in `status` (summary + columns + notes + e.g.).

## Scope — OUT

- Mutation envelope / `summaryOnly` / captures (Task A). · `impact` (Task D). · scale (daemon-singleton).

## Definition of done

- `npm run fix-and-check` GREEN; full suite 0 fail. The status golden (`test/golden/status.golden.txt`)
  WILL change — regenerate with `UPDATE_GOLDEN=1` and confirm the diff is ONLY the intended GUIDANCE
  removal + the new op + brief plumbing. Golden is NOT a correctness oracle (§16).
- `find_unused_exports` has a REAL oracle (a cold `ts.Program` / hand-curated fixture): a used export
  is NOT reported; a truly-unused one IS; a barrel-/dynamic-reached one is `partial`. Plus the
  semantic win over grep (an aliased import that text-grep would miss is still counted as a use).
- Ethos: bounded (cap the whole-repo answer — it caps fast), wrapped external calls, honest partial.
  Layering (ops→plugins); files ≤300 lines. Dogfood: validate `brief`/`op`/`find_unused_exports`
  live through the MCP (`node src/bin.ts mcp` or CLI `op`) against a real repo.

## Files

`src/format/render/render-status.ts` (brief + single-op detail) · `src/daemon/orchestrator.ts`
(status() brief plumbing + GUIDANCE removal) · `src/mcp/schema.ts` (`statusToolSchema`: `brief`/`op`
— **OVERLAP** with Task A's `summaryOnly` in `opRequestSchema`; different schema, keep localized) ·
`src/ops/find-unused-exports.ts` (new) · the `ts` plugin (a new public method) · `src/ops/builtins.ts`
(register — **OVERLAP** with Tasks C/D/F) · `src/format/` · `test/golden/status.golden.txt` + tests.

## Parallel-run note

Independent of Task A except the trivial `mcp/schema.ts` spot. Shares `builtins.ts` op-registration
and the status golden with Tasks C/D/F — mechanical merges (distinct op entries). Own branch/worktree.
