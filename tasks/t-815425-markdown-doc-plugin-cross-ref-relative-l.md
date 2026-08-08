---
id: t-815425
title: 'Markdown/doc plugin: §-cross-ref + relative-link resolution, heading outline (`list registry:sections`), doc↔code drift anchors; + `status` should report TS source-file count'
status: backlog
priority: high
tags:
  - dogfood
type: feat
complexity: L
area: docs
source: dogfood-jul
relates:
  - t-089408
  - t-233427
  - t-691093
  - t-891340
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

## Свидетельство — the EXTERNAL half: a spec vault that reimplemented our op surface in node (dogfood-inbox-aug)

Four independent field reports, 2026-08-01..08-03, all from `/Users/cody/Dev/amiro-brain` — a 92-file
pure-markdown spec/ADR/glossary corpus for an EMR product, by agents who only USE codemaster. Priority raised
low→high on this: the earlier reports were internal doc-review friction; these are a repo where the tool is
structurally unusable and a hand-rolled substitute already exists.

The corpus carries exactly the graph this task models, in markdown: every rule/flow/entity has a stable ID
(`PAT-R-014`, `SCH-F-002`, `ent-patient`, `TEAM-R-036`), IDs are cited by bare mention from prose in other
files, files cross-link with relative markdown links and heading anchors, front-matter carries status fields,
and a glossary defines canonical terms with forbidden synonyms.

**The strongest single datum: `scripts/validate.mjs` in that repo reimplements a chunk of our op surface** —
ID uniqueness, "a bare ID mentioned in prose resolves to a real definition", dead links/anchors, orphan files
not registered in an index, forbidden ID ranges. Reporter: «rename_symbol + impact alone would replace a
hand-rolled node validator in this repo.»

Ops the reports asked for by name, in their own priority order:
- `find_usages` on an ID (which files cite `PAT-R-014`) — grep gets this WRONG on prose: substring hits inside
  longer IDs, mentions inside code fences and front-matter. Same failure mode as grep on aliased TS imports;
  wikilink aliases (`[[note|alias]]`) are the markdown analogue of `import {X as Y}`.
- `find_definition` on an ID (which heading declares it).
- `impact` / blast radius: «"I am deprecating TEAM-R-036 — what cites it, transitively." This is the single
  most valuable manager-side query in a spec repo and there is nothing for it.»
- `find_unused_exports` analogue: a defined ID nothing ever cites (a dead rule).
- `importers_of` on a directory: who links into `domains/catalog/`.
- `rename_symbol` analogue: renumber/deprecate an ID and repoint every citer.
- heading-anchor validation (`#anchors` that no longer exist), front-matter schema queries ("all notes with
  `status: draft`"), and `find_usages` for a spec ID across SIBLING CODE repos.

Config surface the reports propose is small and opt-in — `{docGraph: {idPattern, definitionPattern: "heading
contains id", linkKinds: ["markdown-relative","bare-id-mention"]}}` — i.e. no LanguageService, and the ID/link
conventions declared rather than guessed.

The refusal half of these reports (first contact gives no next step, and the "add a codemaster.config" clause
cannot be certified by the reader) is split out as t-891340 and is fixable independently of this capability.

## The dogfooding corpus for this is already in the repo

The four external reports come from one docs repo, but the most frequent consumer of a markdown/doc-graph engine is codemaster itself. Three corpora we are obliged to read on every triage are exactly the shape this engine models:

- `tasks/` — ~500 `.md` files with a stable id per file, typed cross-references (`parent`, `depends_on`, `relates`) AND free-text `t-xxxxxx` mentions in bodies. "Who references this id" is a graph query answered today by grep.
- `ARCHITECTURE.md` — ~30 `§`-anchored cross-references, plus the doc↔code edges CONTRIBUTING requires to stay at present state.
- `~/.codemaster/feedback/inbox.md` — entries with a derivable stable id (kind + title + timestamp) and node boundaries, currently addressed by HEADER LINE NUMBER, which breaks on any edit above.

So the engine can be built and dogfooded against a corpus we already maintain, with an oracle we already have (the id/link structure is machine-checkable), before any external repo depends on it. That removes the usual objection to a second engine — that it would be built blind against someone else's conventions.

Note the §6 irony worth naming in the design: SymbolId exists precisely because addressing a symbol by position is fragile under edits, and our own inbox is addressed by line number.
