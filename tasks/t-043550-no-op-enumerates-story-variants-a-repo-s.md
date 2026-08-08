---
id: t-043550
title: "No op enumerates story variants: a repo's 292 co-located *.story.tsx are a statically-analyzable default-export shape, and enumerating them today means DOM-scraping a dev server, which silently drops single-variant stories"
status: backlog
priority: medium
tags:
  - dogfood
  - dogfood-aug
type: feat
complexity: M
area: framework
source: dogfood-inbox-aug
relates:
  - t-509002
surface:
  - ops
  - plugins/react
audience: external
evidence: reported
created: '2026-08-08T12:07:40.307Z'
---
`list {registry:'stories'}` → `found=false` (available: components, dialogs, hooks, mutations, queries,
queryKeys). A repo with co-located stories declares each one as
`export default defineStory({ title, variants: {…}, overlay?, widths? })` — the variant keys are
object-literal keys of the default export, i.e. exactly the statically-analyzable shape codemaster reads and
grep cannot enumerate reliably.

## Ask

A `stories` registry in `list` (or a generic "keys of the default-exported object literal" projection),
emitting per story: id (path from `src/` minus `.story.tsx`), title, variant names, overlay flag, widths,
decorator count. One call replaces a browser-driven enumeration pass, and makes adjacent audits expressible —
"@no-story marker drift", "stories whose variants are populated-only".

## Adjacent, same task's blocker

Stories are reached ONLY through `import.meta.glob('/src/**/*.story.tsx')`, which
`find_unused_exports` / `importers_of` treat as an unresolved dynamic edge — so every story-shaped export
looks importer-less, and any dead-code verdict over them is meaningless. `t-509002` is the glob-literal edge
that makes the registry honest; without it the registry lists things the rest of the tool reads as dead.

## Свидетельство (field report, 2026-08-07, /Users/cody/Dev/amiro)

External agent. Task: screenshot every story variant of the showcase. **292 `src/**/*.story.tsx`.** With no
registry the agent DOM-scraped a running dev server, which "silently drops single-variant stories because the
harness only renders variant tabs when length > 1" — a fallback that is both expensive and quietly
incomplete, in the direction of a false absence.
