# Spec: `status` is the documentation — retire `agent-guide.md`

Status: **approved**. Sequence AFTER polish Stage 1
([spec-feedback-polish.md](spec-feedback-polish.md)) — it builds on the
structured-example machinery and touches the same `render-status.ts`.

## 1. Problem

`status` output and `docs/agent-guide.md` have drifted — inevitably: the guide is
hand-written _next to_ the op definitions, not generated _from_ them. Worse, the
guide is structurally unreachable for its audience: field agents work in other
repos and cannot read this repo's `docs/`. The only documentation that travels with
the MCP server is the `initialize` instructions and the `status` reply — which is
exactly what §7/§11 already promise ("the schema + inline examples in `status` ARE
the documentation"). Make it true, then delete the parallel doc.

## 2. Fixed decisions

- **Embed content, not a file.** No static markdown is inlined into `status`; the
  guide's substance moves into the op definitions and is rendered per-repo. A static
  embed would re-create the drift (and lie about ops that aren't active in this
  repo).
- **`OpDefinition.notes?: readonly string[]`** — short per-op usage notes (1–3
  lines each), rendered indented under the op in the catalogue. Migrate the
  per-op content of `agent-guide.md` here; the bulk belongs to `find_usages`
  (role vocabulary semantics, `groupBy:'enclosing'` explanation, filter honesty,
  multi-symbol form) and the scss ops (dynamic-access → `partial` caveat). Notes
  live ON the definition, so they appear and vanish with the op.
- **A `concepts` block in the status render** — the shared mechanics that belong to
  no single op, authored once (e.g. `ops/concepts.ts`, rendered by
  `render-status.ts`):
  - target forms (`symbol` | `name` — ambiguity returns candidates | `file:line:col`),
  - `verbosity` / `fields` / `format` dials,
  - sql post-filtering in one paragraph + one worked example,
  - the honesty legend: `confidence` values, truncation markers
    (`… N more`, `!! OUTPUT CAPPED`), `FAIL` semantics, freshness lines —
    what each means and what the agent should do about it.
- **Token budget:** `status` stays dense — target ≤ ~120 lines for this repo's
  full catalogue. Notes are clauses, not paragraphs. The deep dive for one op is
  its `argsHint` + structured example, not prose.
- **Delete `docs/agent-guide.md`.** Sweep references (repo docs, README, specs,
  `.claude/` agent definitions, memory files) and repoint them to "call `status`".
  Humans browsing the repo have README + ARCHITECTURE; agents have `status`.
- **`SERVER_INSTRUCTIONS`** states it plainly: "`status` is the complete per-repo
  documentation — call it first; there is no separate usage guide."

## 3. Anti-drift guards

- Per-op notes can't drift to nonexistent ops (they live on the definition).
- A **golden test** snapshots the full status render for a fixture workspace with
  both plugins active (`test/golden/`) — concepts-block or render drift becomes a
  failing test. Golden is acceptable as the only assertion here: this guards
  output _stability_, the §16 "never golden-only" rule applies to correctness
  claims, and example-validity is already oracle-checked by polish Stage 1.1.
- The Stage 1.1 example-validation test keeps covering every example shown.

## 4. Tests

| Claim                                                                     | Oracle                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| every status example validates against its op schema                      | polish Stage 1.1 test (extended to notes' inline examples, if any)             |
| status render stable & complete (plugins, ops, notes, concepts, guidance) | golden snapshot on a two-plugin fixture                                        |
| no references to `agent-guide.md` remain                                  | grep in the test (a removed doc that is still pointed to is a broken-link lie) |

## 5. Non-goals

No `help` op / per-op man pages (the catalogue line + notes must suffice; if an op
needs a page of prose, the op's UX is the bug). No generated markdown artifact of
the guide (nothing ships docs that can drift again). No status pagination —
if the catalogue outgrows the budget, tighten notes first.
