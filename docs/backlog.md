# Implementation backlog

**The backlog now lives in the `task-manager` (MCP), not in this file.** Open items are
one `.md` per task under [`tasks/`](../tasks) — git-native, byte-deterministic, queryable.
This file used to be a ~1050-line `- [ ]` list; that content was migrated verbatim into
`tasks/` (git holds the old file's history).

## Use it

- MCP tools (preferred) — `list_tasks`, `ready_tasks`, `next_task`, `get_task`,
  `create_task`, `set_status`, `tree`; or the `tm` CLI (`tm list`, `tm next`, `tm show <id>`).
- Ask _"what should I do next?"_ instead of scanning a flat file: `tm ready` /
  `tm list "status:backlog priority:>=high"`.
- **Found a bug / debt outside scope? File it** (`create_task`), never drop it — the CLAUDE.md
  rule ("ЧТОБЫ НАЙДЕННЫЕ ПРОБЛЕМЫ НЕ ПРОПАЛИ") now lands in the task manager.

## Field taxonomy (mirrors the old `type · imp · cx` tags + section)

The old inline tags map to task-manager fields (see [`tasks/config.yml`](../tasks/config.yml)):

| old tag           | field        | values                                                                                                                                                                                         |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bug`/`feat`/…    | `type`       | bug · feat · perf · dx · infra · doc · imp                                                                                                                                                     |
| `imp` (high/med…) | `importance` | low · medium · high                                                                                                                                                                            |
| `cx:S/M/L`        | `complexity` | S (hours) · M (a PR) · L (a fat task / design needed)                                                                                                                                          |
| _section header_  | `area`       | bug-sweep · phase-4/5/6 · platform · multi-program · ts-refactor · transaction · scss · i18n · impact-usages · framework-seams · density · render-contract · full-density · correctness · wish |

Examples: `tm list "area:ts-refactor"` · `tm list "type:bug importance:high"` ·
`tm list "area:phase-6 -is:blocked"`.

## Definition of done (per item — unchanged)

`npm run fix-and-check` green · oracle-backed test ([ARCHITECTURE.md §16](../ARCHITECTURE.md)) ·
no file > 300 real lines · no upward import · no cyclic plugin deps · new boundary zod-validated ·
new external-tool call wrapped → `ToolFailure` · docs at present state · honest freshness
aggregated from every plugin touched.
