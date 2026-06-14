# Spec: kitchensink integration tests — the port's first realistic workout (+ oracle hardening)

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §1 (north
star), §3 (trust contract), §7 (edit model), §16 (honesty harness); `docs/spec-refactor-port.md`,
`docs/spec-css-coextract.md`, `docs/spec-synthetic-fixture.md`; and CONTRIBUTING.md before
starting. This spec is the contract; where it is silent, those documents rule.

## 1. Purpose

The Phase 2 symbol-anchored refactor ops (rename / move / extract / change*signature / codemod +
CSS co-extract) shipped, and the `kitchensink` trap-zoo fixture shipped — but they have never met.
kitchensink's stated job (spec-synthetic-fixture §1) is to be the **realistic blast-radius
substrate** for the port: "rename/move across many importers, … the place where \_many call sites
of one symbol* is real." Today only **trap-presence** tests exist (the fixture asserts its own
traps are present). This spec adds the **op-level integration tests** that drive the port over the
substrate — its first adversarial workout on a dense, real-shaped graph — and closes three weak
oracles the review left.

This is a **test-writing** task. It writes no production code of its own — but it is **expected to
find bugs** in the just-merged port (that is the point of an adversarial workout on a dense graph).
How those bugs are handled is the load-bearing part of this spec — §2.

## 2. Failure discipline (the load-bearing rule — read twice)

A red integration test here is almost always a **real port bug to surface**, not a test to weaken.
The trust contract is the product; a test that passes for the wrong reason is worse than no test.
So, when a test goes red:

1. **Never weaken or adjust a test to match buggy output.** Build every `expected` set by **reading
   the fixture by hand** and reasoning about what the op MUST do — never by pasting the op's current
   output into `expected`. (This is the exact anti-pattern the consolidation review caught:
   inclusion-instead-of-equality on `find_usages`. Don't reintroduce it.)
2. **A localized, non-destructive bug** (a wrong emitted specifier, a misclassified css rule, an
   off-by-one span — the shape of the emit-ext / scss-classify one-liners already fixed) → fix it
   **with a regression test** pinning the exact repro, and note it in `FINDINGS.md`.
3. **Anything touching the destructive path** (rollback / commit / `git mv` / content-write) **or
   any bug you are not certain is localized** → **STOP. Do not do destructive-path surgery
   unsupervised.** Instead: (a) file it via the `feedback` op (kind `bug`, with the repro), (b)
   record it in `FINDINGS.md` (repro + the failing oracle + suspected cause), (c) **quarantine the
   test** — `test.skip` with a `// QUARANTINE(<finding-id>): <one-line reason>` comment — so the
   suite stays green-or-honestly-quarantined, never red-and-ignored.
4. Maintain **`docs/findings-kitchensink.md`** (create it) — every bug surfaced, every quarantine,
   with its disposition. This is the deliverable's audit trail; an empty findings file with all
   tests green is a fine outcome, a findings file with quarantines is the honest one.

## 3. Oracle rule (non-negotiable, §16)

The fixture is **input**; the oracle is **independent**:

- **cold-LS** — a fresh-from-cold `ts.Program` / `LanguageService` over the post-op tree
  (`test/helpers/cold-ls.ts`). After a rename/move, a cold `findReferences` on the symbol must
  resolve **the same set** the op claimed to rewrite. Never compare the warm daemon to itself.
- **`tsc --noEmit` clean** — the project's own TS over the applied result (a wrong rewrite fails to
  compile). The strong gate for every apply.
- **git byte-exact** — dry-run leaves `git status` clean; `diff(dry) == diff(apply)`; rollback
  restores byte-exact; `git log --follow` finds pre-move history.
- **independent css class scan** (co-extract) — moved/left-behind classes vs a hand classification,
  not the plugin's own verdict.

Hand-curated expected sets are legitimate ground truth (and stronger than a cold `findReferences`
for `find_usages`, which would run the identical LS algorithm — circular). Use them, but derive
them by reading the fixture.

## 4. The high-risk hit-list (deliberate coverage, not incidental)

This is the port's first dense workout — target the cases most likely to break, each mined from a
real project (spec-synthetic-fixture §8 provenance):

- **Dual-spelling rewrite on move (M11)** — moving `src/lib/util.ts` must rewrite importers that
  wrote **both** `@/lib/util` **and** `@/lib/util.ts`. A rewriter handling only one spelling leaves
  half the imports dangling. (Read side already verified equal; the WRITE side is unproven.)
- **`import('…').Type` type-query rewrite on move (M12)** — moving `src/data/shapes.ts` must rewrite
  the embedded path inside `x?: import('@/data/shapes').Envelope` — not an ES import, needs the TS
  AST. ES-import-only rewriting misses it entirely.
- **Dynamic `import('./X')` specifier + lazy registry (M9)** — moving a module referenced by a
  `lazy(() => import('./X'))` registry entry must rewrite the dynamic specifier; a symbol rename
  can't reach the string path (honest-limitation — assert it's flagged, never silently wrong).
- **const-enum member rewrite (T13)** — rename across const-enum member refs (inlined, no runtime
  object).
- **Folder move + sibling `.module.scss` carry** — moving `features/widget/` carries
  `Widget.module.scss`; importers + the css import rewrite.
- **High-fan-in rename (T2/T3)** — rename `formatLabel` (≥6 sites, ≥4 files) / `Registry`; every
  cross-file site, through the M4 barrel-and-deep dual path.
- **Extract from the T12 monolith** — extract a nested helper that captures outer-scope types/vars
  (closure capture); + CSS co-extract on a Widget (safe vs unsafe rules).

## 5. Stages (each PR-sized; oracle-backed; failure discipline §2 applies to every one)

**Definition of done per stage** (§17 + CONTRIBUTING): `fix-and-check` green · the new tests green
**or** honestly quarantined with a `FINDINGS` entry · any localized fix carries a regression test ·
no destructive-path surgery without sign-off · the kitchensink fixture stays `tsc`-clean and its
trap-self-test green if extended · docs at present state.

### Stage 1 — `rename_symbol` over the substrate

- **Build.** `test/e2e/kitchensink-rename.test.ts`: rename a high-fan-in symbol (`formatLabel`,
  `Registry`) via `projectFromDir('kitchensink')`; assert (cold-LS) every prior reference now
  resolves to the new name and the prior name is `gone`; both M11 spellings of any renamed module's
  importers update; the M4 dual-path consumers update regardless of path; `tsc` clean; git byte-exact.
- **Exit.** Rename blast-radius proven against the cold oracle; findings recorded.

### Stage 2 — `move_file` over the substrate (highest blast radius)

- **Build.** `test/e2e/kitchensink-move.test.ts`: (a) move the **dual-spelling** file (M11) — assert
  BOTH spellings rewritten; (b) move a file behind an `import('…').Type` (M12) and a dynamic
  `import('./X')` (M9) — assert both specifier forms rewritten (or M9's string-registry flagged
  honestly); (c) **folder move** of `features/widget/` with sibling `Widget.module.scss` carry.
  Oracle: cold-LS find-usages of a symbol in the moved file resolves the same set (no dangling);
  `tsc` clean; `git log --follow` finds history.
- **Exit.** Move + import-rewrite proven on the dual-spelling / type-query / dynamic / folder cases.

### Stage 3 — `extract_symbol` (+ CSS co-extract) over the substrate

- **Build.** `test/e2e/kitchensink-extract.test.ts`: extract a closure-capturing nested helper from
  the T12 monolith (`features/misc/mono.ts`) — assert the extracted file imports the outer-scope
  types/vars it captured and `tsc` is clean; extract a Widget with CSS co-extract — assert
  provably-safe classes moved, unsafe (compound/nested/@extend) left behind, report codes match an
  independent class scan.
- **Exit.** Extract scope-analysis + co-extract proven on the dense case.

### Stage 4 — oracle hardening (close the review's weak kitchensink oracles)

- **Build (extend `test/e2e/kitchensink-traps.test.ts` + fixture as needed).**
  - **S12 `composes`** — make a composition-target class reachable **only** via `composes:` (today
    `.cell` is also used directly, so the path isn't isolable); assert `find_unused_scss_classes`
    does **not** report it plainly "unused".
  - **S5 dynamic-module demotion** — assert a declared-but-statically-unreferenced class in the
    dynamic-access module (`table.module.scss`'s `.active`) reports **`partial`**, not `certain`
    unused (dynamic access demotes the whole module's unused-claims).
  - **M9 honest-limitation** — assert the string-keyed `lazy(() => import('./X'))` registry behavior
    is honest: the dynamic specifier is rewritten on move, and a symbol rename that can't reach the
    string path is flagged (not silently claimed complete).
- **Exit.** The three weak oracles now pin codemaster's honest behavior.

## 6. Notes

- **Extending the fixture is expected** for specific blast-radius scenarios (a known importer set to
  assert against, an isolable composes target). Constraint: keep it `tsc`-clean and the trap-self-test
  green; add the trap to the spec-synthetic-fixture matrix if it's a new shape.
- Reuse `test/helpers/repo-fixture.ts` (`projectFromDir`) — do not stand up a second loader.
- These tests are the substrate for Spec B's CI gate; Spec B must not become a hard gate while any
  Stage-4 finding is quarantined-red (sequence: this spec's tests green-or-quarantined → CI hard gate).

## 7. Review protocol

Per stage, run **bug-reviewer** (are the oracles independent? is any quarantined finding actually a
real bug vs a test mistake?) and **doc-sync-reviewer** (findings file + plan.md). The oracle tests
are the objective gate; a green suite with an honest `findings-kitchensink.md` is the deliverable.
