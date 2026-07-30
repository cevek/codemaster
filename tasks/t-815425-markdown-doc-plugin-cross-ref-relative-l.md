---
id: t-815425
title: 'Markdown/doc plugin: §-cross-ref + relative-link resolution, heading outline (`list registry:sections`), doc↔code drift anchors; + `status` should report TS source-file count'
status: backlog
priority: low
type: feat
complexity: L
area: docs
source: dogfood-jul
relates:
  - t-089408
  - t-233427
  - t-691093
surface:
  - docs
  - ops
audience: both
evidence: reported
created: '2026-07-07T20:07:21.815Z'
---
Inbox entries 16, 17, 18, 19, 139, 144, 146, 151 (`task-manager`, docs-heavy/greenfield sessions), 2026-07-03. Architecture-doc reviews fit codemaster's proof-carrying model but have zero applicable ops today (all ops are TS/React-symbol-shaped), so the whole session runs on Read + manual cross-referencing.

Wishes: (1) a markdown/doc plugin — resolve intra-doc `§N` cross-refs and relative links (ARCHITECTURE.md has ~30), a heading outline / `list {registry:'sections'}`, and later doc↔code drift anchors ("does the symbol/file a doc names still exist" — a natural join with the `ts` plugin). Would also serve the `doc-sync-reviewer` flow. (2) Greenfield/docs-only discoverability: `list` on a zero-source repo returns `found=false` which can't distinguish unknown-registry vs empty-project vs no-TS-source; and `status` doesn't state "0 TS source files". A one-line `sources: N files` in the status header + a "no TS sources under root" hint on `list`/plugin-not-active would settle it up front.

**Related:** t-089408 supplies the denominator this ask needs: 4 of 5 question types in a doc track legitimately belong to `ls`/Read/grep, so a doc plugin is worth building for the residue, not for the volume. Its part 2 (`list` on a zero-source repo cannot distinguish unknown-registry from empty-project) is the same gap t-691093 reports on `list`.

## The negative-result half, measured over a 432-file document tree (dogfood-jul)

A track that enriched 84 tasks and then swept the whole open backlog made ZERO codemaster calls — correctly,
per t-089408: the work was Markdown + YAML frontmatter, which belongs to git/jq/grep. But ONE class inside it
was structural, hit three times, and no op reaches it.

### The class: a document asserts a universal over a set whose own metadata contradicts it

An epic title said "five MEASURED instances"; its five members carry frontmatter `evidence:
measured|repro|reported` — two measured, two repro, one reported. The universal was false against data
sitting in the tree, in a structured field, checkable mechanically. Three instances in one pass:
1. epic title/body universal vs members `evidence`;
2. a section disqualifying candidates as "`reported` — a self-report" while an existing member carried
   `reported` (a reviewer caught it, not a tool);
3. a stated promotion criterion that, applied literally, promoted the one item the same section excluded —
   because the operative fact (an ops `notes` now disclose the gap, `src/ops/trace-field-to-render.ts:49`)
   lived in a THIRD place: the source. This one is doc↔CODE drift, this tasks own anchor class.

The shape is not task-manager-specific: ARCHITECTURE.md is the same — §-sections asserting universals over
ops/plugins whose real properties live in `OpDefinition`s and plugin manifests.

### What would catch it — the JOIN, not the parser

Enumerate the members a document names (or that name it via a parent/ref field), project their structured
fields as ROWS, and let the existing `sql` surface do the contradiction check:

    SELECT m.id, m.evidence FROM members m WHERE m.parent = <epic> AND m.evidence <> :measured

One row back = the claim is false. So the ask is narrower than "a doc plugin": frontmatter/heading facts as
SQL-projectable rows. codemasters differentiator is not markdown parsing — it is that `sql` + proof spans
already exist, so the contradiction returns with `file:line` on BOTH sides.

### Sibling query with no home either: graph symmetry

"Is every non-blocking link readable from BOTH ends?" (the field does not auto-mirror, so a one-way edge is
invisible from the other side). 652 edges, 7 one-way ones, found by a node one-liner over `tm --json`. Same
shape — a relational query over structured fields in many sibling files — and the same query an agent wants
over any ref-graph a repo keeps in files (docs cross-refs, ADR supersedes-chains, `@see` tags).
