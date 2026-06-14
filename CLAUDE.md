# CLAUDE.md

**codemaster** — a stateful, always-on **codebase inspector** for TS/React repos, built for
AI agents. It indexes a project, keeps a live TypeScript Language Service warm, and answers
structural / semantic / refactor queries densely and **proof-carryingly** — so agents stop
grepping. Output is for agents, not humans.

## Docs — where things live (read, don't duplicate)

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — source of truth: north star (§1), trust contract
  (§3), layers (§5), debug (§13), tests (§16), roadmap (§17). Read §1 + §3 before any change.
- **[src/README.md](src/README.md)** — module map + the import/layering contract.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — working rules: hygiene, tests, definition of done.
- **[test/README.md](test/README.md)** — test layout.

Cross-reference these by `§`; keep this file a pointer, not a copy.

## Principles (non-negotiable)

- **Never lie.** Trust is the whole product, so truth > speed (a 5–60 s answer is fine; a
  wrong one is fatal). Every fact carries its `file:line` proof, uncertainty is explicit,
  and you state plainly what you _couldn't_ do.
- **Never hang.** A hang is worse than a wrong answer — it halts the agent entirely: no result,
  no fallback, all work stops. Every op is bounded: no unbounded loops, no per-call work that
  scales with the repo (cache it), long work is deadline-capped → honest `ToolFailure{timeout}`,
  never a spin. (CONTRIBUTING "never crash, never hang" · ARCHITECTURE §19.)
- **Built for the long run.** Maintainability beats shortcuts — small, single-responsibility,
  strictly layered (imports flow downward; `ops/` import only `plugins/`/`support/`/`common/`/`format/`/`core/`;
  `plugins/` form a strict DAG; `common/` imports only `core/`; `core/` imports nothing internal).
- **Quality is enforced, not hoped for.** `npm run fix-and-check` (eslint --fix → prettier →
  tsc → knip) must be green before anything is "done".
- **Tests need an independent oracle** — a fixture is only input.
- **Docs describe the present**, never the past — git holds history.
- **Tokens are scarce** — dense, coded output; no noise.

Stack: Node ≥ 20, ESM, strict TS via the raw compiler API (no ts-morph), `node:test`.
Status: scaffolding — build order in ARCHITECTURE.md §17.
