# Findings — kitchensink integration tests

The audit trail for `docs/spec-kitchensink-integration.md` (§2.4). Every bug surfaced, every
quarantine, every pinned honest-limitation the integration workout found over the dense
`test/fixtures/repos/kitchensink/` substrate — with its disposition.

> An empty findings file with all tests green is a fine outcome; a file with quarantines is the
> honest one. A finding here is a real port behavior surfaced by reading the fixture by hand and
> reasoning about what the op MUST do — never the op's output pasted back into an `expected` set.

**Disposition legend.** `PINNED` = correct/honest current behavior, asserted as-is so it flips
loudly if it changes (the §2 KNOWN-GAP pattern); a wish may be filed to improve it. `FIXED` =
localized non-destructive bug, fixed with a regression test. `RESOLVED` = a surfaced wish since
implemented (the disclosure/signal now exists), asserted by a regression test. `QUARANTINE` = a
bug touching the destructive path (or not certainly localized): filed via `feedback`, test
`skip`ped with a `// QUARANTINE(<id>)` marker, never red-and-ignored.

---

## KS-1 — rename through a re-export chain preserves the old name (RESOLVED — signal added)

- **Stage / test.** Stage 1 · `test/e2e/kitchensink-rename.test.ts` → "formatLabel — direct
  path fully renamed; star-reached deep path keeps old name (KS-1)".
- **Repro.** `rename_symbol {name:'formatLabel', newName:'renderLabel'}` over kitchensink. The
  M4 trap: `formatLabel` (decl `src/core/format.ts`) is re-exported by name through `chain/c.ts`
  → `chain/b.ts` (`export *`) → `chain/a.ts`, consumed by `Dashboard.tsx` via that deep path,
  and also re-exported by the hub `shared/index.ts`.
- **Observed.** The decl + every DIRECT importer rename to `renderLabel` (8 files touched). But
  the TS LS (`findRenameLocations` + `providePrefixAndSuffixTextForRename`) PRESERVES the
  re-exported public name by aliasing — `chain/c.ts` and `shared/index.ts` become
  `export { renderLabel as formatLabel }` — and does NOT traverse the `export *` star to reach
  the downstream named re-export (`chain/a.ts`) or its consumer (`Dashboard.tsx`), which keep
  calling `formatLabel`. So the old name survives at exactly 4 sites (chain/a, chain/c,
  shared/index, Dashboard).
- **Oracle.** A cold full-program `tsc` over the applied result is **clean** (zero diagnostics)
  — nothing dangles, the result is semantically correct. A cold `getReferencesAtPosition` on the
  renamed symbol resolves all 10 referencing files (the symbol stayed coherent across the chain).
- **Disposition: RESOLVED — honest TS behavior, now disclosed.** Adjudicated by `bug-reviewer`:
  `src/plugins/ts/refactor/rename/rename-sites.ts` is a pure pass-through of the LS rename
  locations (it adds no propagation logic), and the result compiles clean. codemaster cannot have
  introduced the aliasing; it is faithful `findRenameLocations` behavior — so the rewrite is left
  unchanged (the wish was a missing _signal_, not a correctness bug).
- **The signal (`docs/spec-rename-completeness-signal.md`).** The op envelope used to report
  `{mode:'applied', touched: 8, no partial, empty dropped}` — which read as a COMPLETE rename. It
  isn't: the old name survives as re-export aliases and a live `Dashboard` consumer call.
  `ops/rename-symbol.ts` now discloses the survivors whenever the old name lives on, split by where
  each is VERIFIABLE (§3.2):
  - a span-free `summary` (plan-relative: "rename → `renderLabel` would not fully replace
    `formatLabel`: N alias(es) and M `export *` site(s) keep it") rides the envelope `notes` in
    EVERY mode — so a dry-run preview already warns the rename is incomplete;
  - the proof-carrying `oldNameSurvives` field rides the **applied-success** envelope only (its
    alias spans are computed from the post-rename content, so they match disk only after a clean
    apply — never emitted on a dry-run/refused/rolled-back envelope, where disk still holds the old
    text). Its two span lists: `reExportAliases` — `export { renderLabel as formatLabel }` the LS
    introduced (`chain/c.ts`, `shared/index.ts`); `exportStarConsumers` — sites the LS rename never
    traversed (the `export *`-reached `chain/a.ts` re-export + `Dashboard.tsx` call), computed as
    the symbol's `referenceSpans` (which DOES walk `export *`) minus the rename's touch-set.
    Absent entirely on a genuinely complete rename (`Registry` / `Code.Ok` carry no note — asserted
    as the no-false-positive controls).
- **Test.** `test/e2e/kitchensink-rename.test.ts` now asserts the note names both survivor
  classes with valid spans, and that the two control renames carry none. The behavior flips
  loudly if the rewrite ever changes (the rename never propagates through the star — a deliberate
  non-goal; honest disclosure first).

---

## Stage 2 (`move_file`) — no findings

The move-import-rewrite workout surfaced **no port bugs**. M11 (dual-spelling — both `@/lib/util`
and `@/lib/util.ts` rewritten, each keeping its extension style), M12 (the three embedded
`import('@/data/shapes').Type` queries + the ES `import type`), M9 (the dynamic `import('./X')`
specifier), and the `features/widget/` folder move (carrying both `Widget.module.scss` and the
bare side-effect `w.scss`, rewriting the value / `Widget as Card` re-export / dynamic-registry
importers, history preserved) all pass with a clean cold full-program compile. An empty findings
section with green tests is the §2.4 "fine outcome".

---

## KS-2 — extract of a closure-capturing helper: type-only captures imported as values (QUARANTINE + bug filed)

- **Stage / test.** Stage 3 · `test/e2e/kitchensink-extract.test.ts` → the pinned
  "buildReport — captures identified; extract honestly refused…" (green) **and** the quarantined
  "buildReport — extract is tsc-clean…" (`test.skip` `// QUARANTINE(KS-2)`).
- **Repro.** `extract_symbol {name:'buildReport', dest:'src/features/misc/report.ts'}` over
  kitchensink. `buildReport` (top-level export in the T12 monolith `mono.ts`) captures the local
  non-exported decls `Node`, `Accumulator` (interfaces), `ROOT_WEIGHT` (const), plus imported
  `formatLabel`. (The fixture's literal nested closure — `summarize` inside `buildReport` — cannot
  be a "Move to a new file" target; the LS extracts only top-level statements. `buildReport` is the
  faithful top-level stand-in: it exercises the same concern — module-scope captures must
  export-from-source + import-in-new-file.)
- **Observed.** The scope analysis WORKS — the source diff adds `export interface Node`,
  `export interface Accumulator`, `export const ROOT_WEIGHT`, and the new file imports them. But
  the stock LS "Move to a new file" emits a single VALUE import for all captures; under the
  fixture's `verbatimModuleSyntax: true` the type-only members must use `import type`. So the
  post-extract typecheck fails (`'Node' is a type and must be imported using a type-only
import…`) and the §2.8 gate **refuses** (mode stays dry-run, `applied:false`, nothing written).
  - _Separate, UNVERIFIED-by-this-fixture observation (filed alongside in the feedback note, not
    asserted by any test):_ a minimal inline probe — extract a fn capturing a local type used
    ONLY by it — failed even WITHOUT verbatimModuleSyntax with `Module declares 'X' locally, but
it is not exported` (the export wasn't added on that path). The kitchensink `buildReport` case
    does NOT exhibit this (its captured locals ARE exported in the diff), so it is a distinct
    inline-repro lead recorded for the maintainer, not a fixture-proven finding.
- **Oracle.** `git status` clean (zero writes); the refusal `reason` is the §2.8 gate; the
  diagnostic text names the verbatimModuleSyntax type-import requirement.
- **Disposition.** Adjudicated by `bug-reviewer`: honest LS-limitation (the edit producer is the
  stock LS; codemaster's rewrite touches only specifier _text_, never the import clause's
  type-only-ness — `imports/rewrite.ts:104-108`), correctly refused, no destructive risk. Spec §5
  line 116 requires a tsc-clean extract that type-imports its captures — codemaster can't deliver
  it and this is a test-writing task (no prod fix, §1) — so that capability assertion is
  **QUARANTINED** (`test.skip`), the honest refusal is **PINNED** alongside, and a **bug** is
  filed (codemaster `feedback` inbox: split type-only captures into `import type`). The quarantine
  un-skips and the pinned-refusal flips the day extract emits `import type`.

## KS-3 — extract of a sole-export symbol leaves importers dangling; CSS report still correct (PINNED + bug filed)

- **Stage / test.** Stage 3 · `test/e2e/kitchensink-extract.test.ts` → "Widget — CSS co-extract
  report is correct…; TS extract refused (KS-3)" (green).
- **Repro.** `extract_symbol {name:'Widget', dest:'src/features/card/Widget.tsx', css:'copy-safe'}`.
  `Widget` is the SOLE export of `Widget.tsx`, imported by App.tsx (value), shared/index.ts
  (`export { Widget as Card }`), and forms/lazy.ts (dynamic
  `import('@/features/widget/Widget.tsx').then(m => m.Widget)`).
- **Observed.** Two independent dimensions:
  1. **CSS co-extract report (correct, the spec §5 line-118 dimension).** Computed independent of
     apply (`extract-symbol.ts:74`, before `applyRefactorPlan`), so it rides the refused
     envelope. For the classes Widget references: `title`, `badge` (simple single-class) → MOVED;
     `card` → left, `NESTED` (entangled in nested/compound/descendant/comma/`:hover` rules);
     `block__el` → left, `NO-RULE` (the co-extract taxonomy in `extract-classify.ts` doesn't
     resolve `&`, so it finds no flat rule to own — distinct from `scss_classes`, which since
     spec-scss-css-honesty Stage 2 DOES synthesize the flat `block__el`/`block--mod` names).
     Matches an independent hand classification of the sheet.
  2. **TS extract (honestly refused).** Moving the sole export leaves the source without a
     `Widget` export, so the importers dangle (`…has no exported member 'Widget'`; the dynamic
     `m.Widget` member access especially) → the §2.8 gate refuses (`applied:false`, nothing
     written).
- **Disposition.** Adjudicated by `bug-reviewer`: honest LS-limitation, correctly refused, no
  destructive risk. Spec §5 line 118 asks only for the CSS report dimension — which IS delivered
  correctly — so this is **PINNED green** (assert the report + the honest refusal), with the
  TS-side gap (extract of a symbol with external importers should re-export from the source or
  rewrite importers, like `move_file` does) filed as a **bug**.

## KS-4 — find_unused_scss_classes consults `composes:` linkage (CLOSED by spec-scss-css-honesty)

- **Stage / test.** Stage 4 · `test/e2e/kitchensink-oracle-hardening.test.ts` (the companion to
  `kitchensink-traps.test.ts` — the 300-line cap forced the split) → "S12 (KS-4) — a composes-only
  class is partial, never plainly certain-unused" (green; the former quarantine is removed).
- **Fixture extension (spec §6 Notes — allowed).** Added an ISOLABLE composes target to
  `grid.module.scss` (a module with NO dynamic access, so its claims are `certain`):
  `.composeBase` is reachable ONLY via `.composeConsumer { composes: composeBase }`, and
  `composeConsumer` is now used in `Dashboard.tsx` while `composeBase` is never referenced
  directly. (The pre-existing `table.module.scss` composes target `.cell` is also used directly,
  so it can't isolate the composition path — the spec's stated reason for the extension.)
- **Resolution (spec-scss-css-honesty Stage 1).** `find_unused_scss_classes` now consults the
  `composes:`/`@extend` linkage: the scss parse builds per-sheet reachability (`parse.ts`
  `SheetReachability.linkedReachable`, reusing `extract-classify.ts`'s `composesLocalTargets` /
  `parseExtendTargets`), and `unusedClasses` demotes a composes-/extend-reachable class to
  **`partial`** ("reachable via composes:/@extend linkage — cannot prove dead"), never plainly
  `certain` unused. So `composeBase` reads `partial` — an agent can't be misled into deleting it.

### S5 dynamic-module demotion — no finding (pinned green)

Stage 4 also pins the S5 oracle directly: a declared-but-statically-unreferenced class in a
dynamic-access module (`table.module.scss`'s `.active`, where `s[dynamicKey]` demotes the whole
module) reports **`partial`**, never `certain` unused. This works correctly — pinned, no gap.

### M9 honest-limitation — the anticipated limitation does not arise (the finding is its absence)

Spec §5 Stage 4 clause (b) anticipated an honest-limitation: "a symbol rename that can't reach the
string path is flagged (not silently claimed complete)." Pinned in
`kitchensink-oracle-hardening.test.ts` ("M9 — rename reaches the dynamic-import member…"). The
**finding is that this limitation does not occur** in the fixture: renaming `Widget` reaches the
lazy registry's dynamic-import MEMBER access (`m.Widget` → `m.Gadget`) and stays compile-clean, and
the only string present is the module PATH — which a symbol rename correctly leaves untouched
(rewriting it is `move_file`'s job, pinned separately in the same file's "M9 — move rewrites the
dynamic specifier" test). So there is nothing incomplete to flag — the op is honest by reaching
every semantic ref and not faking path surgery. A genuine "can't reach a string" case would need
the symbol's NAME embedded in a string literal, which this `m.X`-member-access registry doesn't
have. Not a bug; recorded so the audit trail doesn't read as if clause (b)'s flag was demonstrated.
