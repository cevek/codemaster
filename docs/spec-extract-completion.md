# Spec: `extract_symbol` — complete the import/export edits the LS leaves incomplete (KS-2, KS-3)

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §3 (trust
contract), §4 (the patched-LS extract rescue), §7 (edit model — esp. the §2.8 typecheck gate),
§16 (honesty harness); and CONTRIBUTING.md before starting. Refines the KS-2 + KS-3 extract
limitations surfaced and **quarantined** by the kitchensink-integration work — the repros live
(quarantined) in `test/e2e/kitchensink-extract.test.ts`, which PIN the honest refusal this task
would turn into a clean extract.

## 1. Problem

`extract_symbol` drives the TS LS "Move to a new file" refactor, then post-processes its edits. On
three real cases the LS's emitted edit set is **incomplete**, so the §2.8 post-typecheck gate
**correctly REFUSES** (nothing written, no corruption — honest) — but extract then **can't complete a
legitimate extraction**. This spec completes the post-process so the gate passes on these cases.

**The gate refusing is correct and must stay** — this is not a safety fix (there is no corruption; the
gate caught the incompleteness). It is a **completeness** fix: finish the edits the LS left half-done.

The three cases (all pinned in `test/e2e/kitchensink-extract.test.ts`):

- **KS-2a — type-only capture emitted as a value import.** Extracting a symbol that captures
  non-exported local decls (e.g. `buildReport` in `features/misc/mono.ts` capturing interfaces `Node`
  / `Accumulator` + const `ROOT_WEIGHT`) correctly adds `export` to those decls and imports them in
  the new file — but the LS emits a single **value** import `import { Node, Accumulator, ROOT_WEIGHT }
from './mono'`. Under `verbatimModuleSyntax:true` the type-only members must use `import type` (or an
  inline `import { type Node, type Accumulator, ROOT_WEIGHT }`). Typecheck fails → gate refuses.
- **KS-2b — missing export on a local-type-only-capture path.** A fn capturing a local **type** used
  ONLY by that fn fails even **without** `verbatimModuleSyntax`, with "Module declares X locally, but
  it is not exported" — the `export` is not added on that path.
- **KS-3 — sole-export symbol leaves importers dangling.** Extracting a symbol that is its file's SOLE
  export and is imported elsewhere (e.g. `Widget`, imported by `App.tsx` value import, `shared/index.ts`
  `export { Widget as Card }`, and `forms/lazy.ts` dynamic `lazy(() => import('@/…/Widget.tsx').then(m
=> m.Widget))`): after the move the source no longer exports it, but the external importers — **incl.
  the dynamic-import member access `m.Widget`** — are not repaired, so they dangle. Gate refuses. (The
  CSS co-extract report is still computed correctly on the refused dry-run — preserve that.)

## 2. Fixed decisions

- **Do not weaken the §2.8 gate.** It is doing its job. Make the emitted edits complete so a legitimate
  extract type-checks; a genuinely-unsafe extract must still refuse.
- **Reuse, don't duplicate.** KS-3's importer repair must reuse `move_file`'s import-rewrite machinery
  (`plugins/ts/refactor/imports/*`), **including the dynamic `import('…')` specifier + member-access
  handling** — do not stand up a second rewriter. KS-2's type-vs-value decision uses the ts plugin's
  type checker / symbol flags (a captured name is type-only iff its symbol has no value meaning) — do
  not hand-roll a heuristic.
- **KS-3 strategy — rewrite importers (preferred), re-export as the honest fallback.** Repoint external
  importers to the new module (consistent with `move_file`'s contract), including the dynamic
  `m.Widget` member access. If an importer cannot be safely rewritten, fall back to leaving an
  `export { X } from './new'` re-export at the source and surface a note (§3.6) — never leave it
  dangling, never silently change the public path without disclosure.
- **All edits are post-processing of the LS output + the shared importer-rewrite** — no change to the
  "Move to a new file" call itself.

## 3. Stages

**Definition of done per stage** (§17 + CONTRIBUTING): `fix-and-check` green · the matching KS-2/KS-3
repro in `test/e2e/kitchensink-extract.test.ts` flipped from quarantine to a green oracle-backed test ·
post-apply `tsc` clean (the strong gate) · cold-LS refs resolve, git byte-exact · ≤300 lines · no
duplicated rewriter · docs at present state.

### Stage 1 — KS-2a: split type-only captures into `import type`

- **Build.** After the LS emits the new file's import of the now-exported captures, classify each
  imported name via the ts checker (type-only vs value) and rewrite the import to `import type { … }`
  for the type-only set, or an inline `import { type T, value }` mixed form. Honors `verbatimModuleSyntax`.
- **Oracle.** Extract `buildReport` from `mono.ts` → post-apply `tsc` clean under
  `verbatimModuleSyntax:true`; the new file uses `import type` for `Node`/`Accumulator`, value import
  for `ROOT_WEIGHT`; KS-2a flips to green.

### Stage 2 — KS-2b: add the missing export for a local-type-only capture

- **Build.** Ensure `export` is added to **every** captured local decl the extracted file references,
  including a type used only by the extracted fn (the path that currently misses it).
- **Oracle.** A minimal extract of a fn capturing a local type used only by it → source gains the
  `export`, new file imports it (as `import type`), `tsc` clean even without `verbatimModuleSyntax`.

### Stage 3 — KS-3: repair external importers of a sole-export (incl. dynamic member access)

- **Build.** When the extracted symbol has external importers, reuse `move_file`'s importer rewrite to
  repoint them to the new module — value imports, `export { X as Y }` re-exports, **and** dynamic
  `import('…').then(m => m.X)` member accesses. Honest re-export fallback (§2) when an importer can't
  be rewritten, with a note. Preserve the co-extract report on the (now-applied) envelope.
- **Oracle.** Extract `Widget` (sole export, with css co-extract) → `App.tsx` / `shared/index.ts` /
  `forms/lazy.ts` all resolve post-apply (cold-LS, no dangling); `tsc` clean; git byte-exact; the css
  co-extract report still correct; KS-3 flips to green.

## 4. Review protocol

- **bug-reviewer** — the gate still refuses a genuinely-unsafe extract (don't trade the gate for
  completeness); the dynamic `m.Widget` rewrite is correct; the type-only split doesn't mis-classify a
  value as a type or vice-versa; no dangling importer after KS-3.
- **copy-paste-reviewer** — KS-3 reuses `move_file`'s importer rewrite (not a second resolver/rewriter);
  the type-only decision uses the checker, not a regex.
- **doc-sync-reviewer** — the KS-2/KS-3 quarantine in `test/e2e/kitchensink-extract.test.ts` is lifted
  (the clean-extract MUST replaces the pinned honest-refusal); ARCHITECTURE §4/§7 "known limitation"
  notes (if any) updated to present state.
