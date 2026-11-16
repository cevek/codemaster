# codemaster

A stateful, always-on codebase inspector for TS/React repos, built for AI agents: a warm TypeScript
LanguageService plus domain plugins answer structural / semantic / refactor queries densely and
proof-carryingly. Its output is read by agents, not humans.

## Invariants (non-negotiable)

Required-vs-backlog triage (plan gate, review severity, follow-up tasks) measures against these.

- **Never lie.** Truth beats speed (an answer in 5–60 s is fine, a wrong one is fatal). Every fact
  carries a `file:line` proof, uncertainty is explicit (`unresolved` / `partial` / `dynamic`), no
  silent truncation, what we could not do we say outright. ARCHITECTURE §1, §3.
- **Never hang.** A hang is worse than a wrong answer: it stops the agent entirely. No unbounded loop,
  no per-call work that scales with repo size (cache it), long work under a deadline → an honest
  `ToolFailure{timeout}`, never a spin. ARCHITECTURE §1, §19.
- **Every external call is wrapped** (TS LS, git, ast-grep, prettier, fs) → `ToolFailure`, never an
  escaped exception, never a guessed result.
- **Strict layering.** Imports flow down only: `ops/` → `plugins/` / `support/` / `common/` /
  `format/` / `core/`; `plugins/` is a strict DAG; `common/` → `core/` only; `core/` → nothing
  internal. Map and import table: `src/README.md`.
- **Boundaries are zod-validated** (config, MCP args, IPC). **≤ 300 lines** of code per file — split,
  never raise the cap.
- **Tests are an independent oracle**; a fixture is only input. **Tokens are expensive** — dense,
  coded output.

Stack: Node ≥ 22, ESM, strict TS over the raw compiler API (no ts-morph), `node:test`.

## Before you act — read

- Changing anything under `src/` or `test/` → `CONTRIBUTING.md` in full (gates, hygiene, done
  definition) and `ARCHITECTURE.md` §1 + §3; then the § of the subsystem you touch.
- Adding, moving or importing across modules → `src/README.md`.
- Writing or moving a test → `test/README.md` and ARCHITECTURE §16.
- Editing a doc → `ARCHITECTURE.md` is the source of truth; cross-reference it by `§`, never copy it.
- Filing, triaging or closing a task → CONTRIBUTING "Backlog discipline" in full.
- Choosing what to work on next → `npm run queue`, not the `ready_tasks` order (it sorts by
  `priority`, which here only breaks ties — CONTRIBUTING "What to work on next").

## Gate

`npm run fix-and-check` green before "done". It strips mechanical dead code itself (unused imports via
eslint, truly-dead exports via knip) — never delete that by hand. Running the full suite →
`node scripts/with-test-lock.mjs -- npm test`, never bare (CONTRIBUTING "The gate").

## Dogfooding — codemaster runs on this repo

- After an edit to `src/`, a running MCP server serves pre-edit code (the `!! PRE-EDIT` banner says
  so). Ask current source through the one-shot CLI `node src/bin.ts op <name> '<json>'`, and
  reproduce broken-looking output there before calling it a regression — a stale daemon is the usual
  cause. CONTRIBUTING "Self-dev loop".
