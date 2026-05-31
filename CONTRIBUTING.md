# Contributing — for agents

You are most likely an agent building codemaster. Read **[ARCHITECTURE.md](ARCHITECTURE.md)**
§1 (north star) and §3 (trust contract), plus **[src/README.md](src/README.md)** (layering),
before editing. ARCHITECTURE.md is the source of truth; this file is the working rulebook.

**One command:** `npm run fix-and-check` — `eslint --fix` → `prettier` → `tsc` → `knip`.
Green before anything is "done".

## Prime directive — never lie

The tool's only asset is trust. So: every fact ships with its proof span; uncertainty is
explicit (`unresolved` / `partial` / `dynamic`); partial or failed work is reported, never
disguised as complete. Type/semantic facts come **only** from the live Language Service,
never a snapshot. (§3.)

## Resilience — never crash

Every call to an external tool — the TS LanguageService, git, ast-grep, prettier, the
filesystem — is wrapped in try/catch. On failure we **do not guess or fabricate around
it**: return a `ToolFailure` ("internal tool `X` failed — can't perform this operation")
with empty `data`, so the agent falls back to its own means. An exception must never escape
to the agent, and a guessed result must never stand in for a failed one — the daemon stays
up and answers honestly, with top-level `uncaughtException` / `unhandledRejection` handlers so
a stray rejection never takes the orchestrator down. (The trust contract applied to our own
failures — §3, §19.)

**Never block the orchestrator.** Many agents share one front door — it only routes, so it
never blocks. Heavy work lives in the **workspace engine**, isolated in its own process in
`process` mode (§2). Write the engine **transport-agnostic** — never assume it shares a
process with the orchestrator. (`in-process` mode collapses everything onto one loop for easy
debugging and _does_ block there — the dev default, not the contract.)

## Layering — hard rules ([src/README.md](src/README.md))

- Imports flow **downward only** — no upward edges, no cycles.
- `recipes/` compose **only** primitives.
- `core/` imports nothing internal.

## Code hygiene (most of this is enforced by ESLint)

- **≤ 300 lines** of real code per file. Over the line? Split by responsibility — never
  raise the cap.
- No `any` (explicit or leaked), no `!` non-null assertions, no floating promises. Handle
  `undefined` honestly.
- **Never `console.*`** — stdout is the agent-facing payload; trace through the debug
  subsystem (§13).
- Exhaustive `switch` over discriminated unions (the graph is full of them).
- Import from specific files; barrels only at module edges. Comments say _why_, not _what_.
- A recurring semantic `string`/`number` (path, glob, id, version) gets a **brand**
  (`src/core/brands.ts`), not a bare primitive — category errors become compile errors;
  construct/validate it at the boundary, not inline.
- No `unknown` bags in the domain: discriminate by `kind` so each variant carries typed
  fields, and type the one unavoidable open bag (adapter extras) as `JsonValue`.

## Boundaries — zod

Everything entering from outside — config load, MCP tool args, edit recipes, IPC messages,
snapshot envelope — is **zod-validated, fail-fast, with a pointed error**. Trust typed data
within; guard the edges.

## Tests (§16)

- `node:test` + `node:assert`; run with `npm test`.
- Every test needs an **independent oracle** — a fixture is only input, not proof.
- Default to inline-VFS `project({ ...files })` fixtures (hermetic, no `npm install`); use
  `test/fixtures/repos/` only for realistic and end-to-end cases.
- Never golden-only for a correctness claim — pair it with an oracle.
- No `sleep` in scenarios — drive the injected `clock` / `watcher` seams.

## Output is the product

Dense, coded, for agents — not humans. Always emit clickable `file:line`. Cap large results
with an explicit "N more + how to narrow". No silent truncation. For an agent that already
knows what it needs, prefer one **`batch`** of requests over N round-trips — results return
in order, against one consistent graph version.

## Docs

Describe the **present state**, never the path to it — git holds the history. No
"previously / used to / now changed / resolved". Changing a decision means rewriting the
doc as if it had always been so. Cross-reference ARCHITECTURE.md by `§`.

## Dependencies

Lean — a new dependency needs a reason. A dependency declared ahead of its first use goes
in `knip.jsonc` `ignoreDependencies` with a one-line note; remove it the moment a module
imports it (knip will flag the entry as redundant).

## Done means

`fix-and-check` green · new behavior has an oracle-backed test · any new boundary is
zod-validated · every external-tool call wrapped (no crash, no guess) · docs at present
state · no new upward import · no file over 300 lines · no blocking the orchestrator
(heavy work → the workspace engine, §2).
