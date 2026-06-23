# Contributing — for agents

You are most likely an agent building codemaster. Read **[ARCHITECTURE.md](ARCHITECTURE.md)**
§1 (north star) and §3 (trust contract), plus **[src/README.md](src/README.md)** (layering),
before editing. ARCHITECTURE.md is the source of truth; this file is the working rulebook.

**One command:** `npm run fix-and-check` — `eslint --fix` → `knip --fix-type exports --fix-type
types` → `prettier --write` → `tsc` → `knip`. Green before anything is "done".

**It auto-removes the mechanical dead code — don't hand-edit it.** Two whole classes of
"unused" failure fix themselves, so an agent never spends tokens (or a round-trip) deleting
them by hand:

- **Unused imports** — `eslint --fix` strips them via `unused-imports/no-unused-imports`
  (autofixable). The base `@typescript-eslint/no-unused-vars` is off so the plugin owns
  imports; `unused-imports/no-unused-vars` keeps the _non-import_ dead-binding an **error**
  (same `^_` escape hatch) — deliberately **not** autofixable, since deleting a dead value can
  change behavior, so you stay in the loop on those.
- **Truly-dead exports** — `knip --fix-type exports --fix-type types` strips the `export`
  keyword off a value/type that is **used nowhere** (it stays as a private declaration; tsc
  then nets any consumer the strip would break). It touches **only** the export keyword — never
  files, declarations, or `package.json` deps (the dangerous `--fix-type files`/`dependencies`
  are not enabled). The two `--fix-type` flags are **repeated, not comma-joined**:
  `knip@6.15` silently no-ops on the `exports,types` comma form — use the repeated flag.

The autofix is safe to run blind because of one knip setting: **`ignoreExportsUsedInFile: true`**
(`knip.jsonc`). It makes knip flag — and therefore strip — only exports that are dead
_everywhere_. An export that is **referenced within its own file** (the common
build-the-API-then-add-the-consumer pattern, e.g. a public type that ships one commit ahead of
its first importer) is treated as used and is **never** stripped. So the autofix can't quietly
remove an intended-but-not-yet-consumed contract. The repo's public surface is doubly safe:
`src/index.ts` and `src/bin.ts` are knip **entry points** (resolved from `package.json`
`main`/`bin`), so everything they re-export is "used" and out of the strip's reach.

> **Forward-footgun — the one case the autofix _will_ silently bite.** `ignoreExportsUsedInFile`
> only spares an export that is **used in its own file**. So if you add a **cross-module export
> ahead of its first importer** — the build-the-contract-first pattern — _and_ that export is
> **not referenced anywhere in its own file**, and its file is **not** an entry point
> (`index.ts`/`bin.ts`), then the next `fix-and-check` will **silently strip its `export`
> keyword**. `tsc` does **not** catch this — the symbol simply becomes file-local and still
> compiles; you only notice when the consumer you add next can't import it. To keep such an
> export, in the **same change** either: (a) reference it within its own file, (b) add (or
> re-export through `index.ts`) the consumer, or (c) if it must sit truly unconsumed for now,
> add it to a `knip.jsonc` `ignore`/`ignoreExportsUsedInFile`-exempt entry with a one-line note.
> The default — strip what nothing uses — is the honest behavior; this is the footgun it implies.

## The gate (CI is authoritative)

`.github/workflows/ci.yml` runs on every push and pull request and is the contract: `npm ci`
→ `npm run check` → `npm test` on the Node major pinned in `.nvmrc` (≥ 22 — the test runner
strips types via `node --test`, which Node 20 can't do; `engines` matches). **`check` is the
non-mutating twin of `fix-and-check`** (`eslint` without `--fix`, `prettier --check`, `tsc`,
`knip`) — CI fails on unformatted code instead of silently rewriting it in a throwaway runner.

The job sets `CODEMASTER_REQUIRE_RG=1` and installs + verifies ripgrep, so the `find_usages`
distinctness oracle (`test/helpers/ripgrep.ts`) **fails loud** if `rg` is missing rather than
honest-skipping — locally a missing `rg` still skips that cross-check (see §16).

**Pre-push (optional, convenience):** `.husky/pre-push` runs `npm test` so a red suite never
reaches the remote; `.husky/pre-commit` runs `lint-staged`. Both are local fast gates,
skippable with `git push --no-verify`; CI is the authoritative one.

## Prime directive — never lie

The tool's only asset is trust. So: every fact ships with its proof span; uncertainty is
explicit (`unresolved` / `partial` / `dynamic`); partial or failed work is reported, never
disguised as complete. Type/semantic facts come **only** from the live Language Service,
never a snapshot. (§3.)

## Resilience — never crash, never hang

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

**Never hang — the worst failure.** A hang is worse than a crash or a wrong answer: it halts the
agent entirely — no result, no fallback, all work stops. (We fight lies because trust is the
product; a hang denies even an honest "couldn't.") Hard rules whenever you implement anything:

- **No unbounded loops; no per-call work that scales with repo size — cache it.** Anything derived
  from the tsconfig / file set / tree is computed once and cached, refreshed only on reindex.
  _Incident:_ `ls-host` re-ran `parseJsonConfigFileContent` (a full recursive tree scan) on **every**
  `getCompilationSettings` call → O(LS-calls × tree-scan) → an infinite hang on a 6k-file repo;
  300+ tests over tiny fixtures never caught it (each re-scan was instant).
- **Bound every long operation by a deadline** → on overrun return `ToolFailure{tool:'timeout',
partial}` ("couldn't in N s — fall back to your own tools"), never spin. An honest "couldn't"
  beats a freeze — the exact logic of never-lie, applied to latency.
- **Know what's cancellable** (§19): a deadline `HostCancellationToken` cancels TS _checker/search_
  ops (`find_usages`, navto, diagnostics) — wire it. It does **not** cancel TS _program build_ or
  codemaster's _own_ sync code; bound those by design (cache / scope inputs) and ultimately by
  engine isolation + kill.
- **Test at scale.** A correctness test on a 3-file fixture cannot catch a scale hang — guard hot
  paths with a real-big-repo latency budget, not just an inline fixture.

## Layering — hard rules ([src/README.md](src/README.md))

- Imports flow **downward only** — no upward edges, no cycles.
- `ops/` import **only** `plugins/`, `support/`, `common/`, `format/`, `core/`.
- `plugins/` form a strict DAG (`Plugin.deps`); no cycles, no upward imports between plugins.
- `common/` imports **only** `core/` — pure logic, no I/O, no timers (Clock seam only).
- `core/` imports nothing internal.

**Internal layout of `common/` and `support/<tool>/`**: nothing lives at the root —
every file goes into a topical subfolder, one concept per folder, one operation per
file. **Filenames `utils.ts` / `helpers.ts` / `misc.ts` are banned**: name files by their
operation (`construct.ts`, `merge.ts`, `parse.ts`), not by the kind of contents. A
subfolder reaching ~5 files is the split signal.

## Code hygiene (most of this is enforced by ESLint)

- **≤ 300 lines** of real code per file. Over the line? Split by responsibility — never
  raise the cap.
- No `any` (explicit or leaked), no `!` non-null assertions, no floating promises. Handle
  `undefined` honestly.
- **Never `console.*`** — stdout is the agent-facing payload; trace through the debug
  subsystem (§13).
- Exhaustive `switch` over discriminated unions (`Confidence`, `HandleRebind`, `OpResult`,
  and each plugin's own kind enums).
- Import from specific files; barrels only at module edges. Comments say _why_, not _what_.
- A recurring semantic `string`/`number` (path, glob, id, version) gets a **brand**
  (`src/core/brands.ts`), not a bare primitive — category errors become compile errors;
  construct/validate it at the boundary, not inline.
- No `unknown` bags in the domain: prefer typed fields per variant; when an open shape is
  truly unavoidable (e.g. a plugin's option bag), type it as `JsonValue`.

## Boundaries — zod

Everything entering from outside — config load, MCP tool args (per-op + status + batch),
IPC messages — is **zod-validated, fail-fast, with a pointed error**. Trust typed data
within; guard the edges.

## Tests (§16)

- `node:test` + `node:assert`; run with `npm test`.
- Every test needs an **independent oracle** — a fixture is only input, not proof.
- Default to inline-VFS `project({ ...files })` fixtures (hermetic, no `npm install`); use
  `test/fixtures/repos/` only for realistic and end-to-end cases.
- Never golden-only for a correctness claim — pair it with an oracle.
- No `sleep` in scenarios — drive the injected `clock` / `watcher` seams.

## Self-dev loop (dogfooding)

Drive codemaster against its own tree from the CLI — same front door as MCP, no rebuild
(Node strips types): `node src/bin.ts status` and `node src/bin.ts op <name> '<json-args>'`
(e.g. `node src/bin.ts op find_usages '{"name":"Orchestrator"}'`). Each invocation is a
fresh one-shot process, so it always reflects the current source.

A **long-lived** daemon (the singleton the MCP bridge connects to) does **not** — it serves
the behavior it spawned with. So after you edit `src/`, the running daemon is stale.
`status` and every op response say so outright (`!! daemon code behind source — run
`codemaster daemon restart``), driven by a `src/**` fingerprint taken at spawn (§3.6 applied
to the tool itself). **Run `codemaster daemon restart` to pick up your change\** — it stops the
stale-code daemon so the next bridge spawns a fresh one on current source (a bridge *reconnect\*
alone re-attaches to the SAME stale daemon on the same socket; for the dev loop, `codemaster mcp
--in-process` skips the daemon entirely). The signal degrades silently to off where the source
tree can't be located (a global / `npx` install — §19), never a false positive.

## Output is the product

Dense, coded, for agents — not humans. Always emit clickable `file:line`. Cap large results
with an explicit "N more + how to narrow". No silent truncation. For an agent that already
knows what it needs, prefer one **`batch`** of requests over N round-trips — results return
in order, each touched plugin's freshness captured once at batch entry (§11).

## Docs

Describe the **present state**, never the path to it — git holds the history. No
"previously / used to / now changed / resolved". Changing a decision means rewriting the
doc as if it had always been so. Cross-reference ARCHITECTURE.md by `§`.

## Backlog discipline (`docs/backlog.md` = only what's still open)

`docs/backlog.md` is read by agents as live truth — a resolved item left as `- [ ]` is a
lie about open work, and an agent will build against a bug that no longer exists. Two rules:

- **Close in the same commit you fix.** A `fix(`/`feat(` that closes a tracked behaviour
  MUST, in the same diff, remove (or `[x]`-tick) the matching open item — never defer it to
  a later sweep. The gap between fix and sweep is a window where the backlog reads false.
  Adding newly-found residuals in that commit is fine and encouraged — just don't leave the
  one you closed standing. (Closed items are then dropped wholesale in periodic
  `docs(backlog)` sweeps; git holds the history — see Docs above.)
- **A dogfood finding enters the backlog only after a repro on current `main`.** A
  hedged hypothesis ("appears to…") recorded as an open bug is the other source of false
  entries — the behaviour may already be correct. Reproduce hermetically first (CLI
  one-shot / fixture); if you can't, either omit it or tag it `UNVERIFIED` so the next
  reader knows it's unconfirmed, not a known bug.

## Dependencies

Lean — a new dependency needs a reason. A dependency declared ahead of its first use goes
in `knip.jsonc` `ignoreDependencies` with a one-line note; remove it the moment a module
imports it (knip will flag the entry as redundant).

## Done means

`fix-and-check` green · new behavior has an oracle-backed test · any new boundary is
zod-validated · every external-tool call wrapped (no crash, no guess) · docs at present
state · the closed backlog item struck in the same commit (Backlog discipline) · no new
upward import · no file over 300 lines · no blocking the orchestrator (heavy work → the
workspace engine, §2).
