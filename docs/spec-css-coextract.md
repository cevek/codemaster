# Spec: CSS-module co-extract for `extract_symbol` (Stage G's css half)

Status: **implemented** — `extract_symbol` `css: 'copy-safe'`, on top of the §4 patched-LS
rescue (`plugins/ts/ls-host.ts`) that unblocks extracting a css-using component. Oracles:
`test/unit/scss-extract-classify.test.ts`, `test/unit/scss-extract-rules.test.ts`,
`test/unit/ts-css-usage.test.ts`, `test/e2e/extract-css-coextract.test.ts`. Extends
[`spec-refactor-port.md`](spec-refactor-port.md) (the `extract_symbol` op it builds on — read
its §2.8 gate / §2.10 envelope / apply-rollback contract first) and refines
[`plan.md`](plan.md) Phase 2 Stage G. Read ARCHITECTURE.md §1 (north star), §3 (trust
contract), §5-L2 (plugins are the only domain oracle) / §5-L3 (ops sit above the DAG and are
the join), §12 (output) and CONTRIBUTING.md. Prior art: `front-renamer`'s `extract-css.ts`
(707 lines) — the safe-move heuristic + the per-class taxonomy; this ports its brains onto
codemaster's `scss` plugin + `ts.cssModuleUsages`.

## 1. Problem & idea

`extract_symbol` relocates a top-level TS symbol to a new file (built, TS-only). When the
extracted JSX uses CSS-module classes from a **sibling stylesheet** (`import s from
'./X.module.scss'` + `s.foo`), those classes stay in the original sheet — now imported from
across the tree, and mixed with classes the symbol never used. Co-extract moves the
**provably-safe** classes the extracted block uses into a fresh stylesheet beside the
extracted file, **leaves every ambiguous class behind** (rewriting its references to a
second `sLegacy` import), and reports per-class why.

The governing principle is the §3 trust contract under a **type-blind** medium: TypeScript
never typechecks an `.scss` import, so a wrong class move silently changes styling that no
gate can catch (the same lesson as the aliased-scss-dangle bug). Therefore: **never move a
class we cannot prove safe.** A moved class is a proven claim; everything else stays put and
is reported. Conservative-and-honest beats complete-and-wrong.

## 2. Fixed decisions

### 2.1 Opt-in, off by default

A flag on `extract_symbol`: `css?: 'copy-safe'` (front-renamer's vocabulary, left as a string
mode for future `'copy-all'` / `'move'` variants). Absent → no co-extract (today's behavior).
Co-extract is a safe-**subset** migration heuristic, not a guaranteed-complete refactor — the
agent opts in, and the result is explicitly a partial migration (§2.5).

### 2.2 Orchestrated at the op level — the plugin DAG forbids `ts → scss`

The `scss` plugin declares `deps: ['ts']` (it asks the TS plugin for usages), so
`plugins/ts/refactor/**` **cannot** import the `scss` plugin — that edge would invert the
DAG. Co-extract needs both domains: **TS AST** ("which `s.X` does the extracted block use,
which does the remainder still use") and **SCSS CST** ("which rules are safe to move, move
them"). Ops sit above the DAG and may call any plugin (§5-L3), so co-extract is **the op's
join** — the same shape as `find_unused_scss_classes` (an op joining `ts` + `scss`). A
helper on the ops side orchestrates a back-and-forth:

1. `ts.planExtract(...)` → the `RefactorPlan` **plus** a `cssUsage` analysis (§2.3).
2. op → `scss.classifyForExtract(...)` + `scss.extractRules(...)` → safe vs left-behind, and
   the two rewritten sheet contents (§2.4).
3. op → rewrite the extracted file's CSS import + inject `sLegacy` + repoint left-behind refs
   (§2.5) — TS-domain AST edit, via the extract refactor / `support/text-edits`.
4. op → fold the new sheet + edited sheets + rewritten extracted file into the plan (§2.6).

No plugin reaches across the DAG; the op carries the data between them.

### 2.3 New TS capability — block-scoped CSS-module usage (scope-aware)

`ts.cssModuleUsages()` today scans **whole files** and is **not** scope-aware. Co-extract
needs three things the existing scan does not give:

- **Block scoping** — which `s.X` classes are referenced **inside the extracted symbol's
  subtree** (candidates to move) vs in the **remaining** source (→ `USED`, leave behind).
- **A conservative wildcard** — if the remaining source uses the import name **non-trivially**
  (spread `{...s}`, destructure `const {x} = s`, rebind `const t = s`, computed `s[expr]`,
  pass as an arg) → treat **every** class as still-used (leave all). Literal `s.X` / `s['X']`
  are the only "trivial" forms.
- **Scope-awareness** — skip subtrees where a function parameter / catch var shadows the
  import name (`useStore((s) => s.field)` — that `s` is the lambda param, not the CSS import).
  Port front-renamer's `collectShadowedNames` / `introducesShadowOf`. **codemaster's current
  `scanCssModuleUsages` lacks this** — co-extract must not inherit that gap.

This is TS-domain AST work; it lives in `plugins/ts/refactor/extract/css-usage.ts` and its
result rides out of `planExtract` (the plan already crosses to the op as plain data).

### 2.4 New SCSS capability — classify + extract rules (the plugin's first transform surface)

The `scss` plugin is read-only today (`classes` / `unusedClasses`). Co-extract adds two
**pure** functions (return data/strings; the op does all I/O — the plugin stays
side-effect-free, consistent with §5-L2):

- **`classifyForExtract(file, classNames, { usedInRemaining: Set<string> }) → Map<class,
Verdict>`** — the safety taxonomy (§2.7), computed over the postcss-scss CST. Read-only.
- **`extractRules(file, safeClassNames) → { newSheet: string; sourceSheet: string }`** —
  clone the safe rules (with their leading comment blocks) into a new sheet string; remove
  them (and the comments) from a clone of the source; serialize both. Pure transformation;
  the op writes the strings through the plan. `.module.css` uses `postcss`, `.module.scss`
  uses `postcss-scss` (by extension), mirroring front-renamer.

Selector-ownership, at-rule/sass-var/`@extend` detection, and CST serialization are
SCSS-domain knowledge and **must** live in the `scss` plugin, never inlined in the op (§5-L2:
the plugin is the only oracle for its domain).

### 2.5 Leave-behind is visible, never silent (the `sLegacy` pattern)

- Moved classes → new sheet; the extracted file's CSS import repointed to it.
- Left-behind classes → stay in the source sheet; the extracted file gains a **second**
  import `<name>Legacy` → the old sheet, and its `s.X` / `s['X']` references for left-behind
  classes are rewritten to `sLegacy.X` (scope-aware — skip shadowed subtrees, §2.3).

The two-import shape is intentionally ugly: it makes a partial migration **visible** instead
of papering over it (§3.6 report-capability — we did part of the job and say so out loud).

### 2.6 Plugs into the existing apply machinery — no new write/rollback path

Co-extract folds into the existing `RefactorPlan`: the new stylesheet → `plan.newFiles` (+ a
`diff` add); the edited source stylesheet → `plan.contentWrites` (+ a `diff` edit); the
rewritten extracted file is the SAME synthetic `plan.newFiles` entry the TS extract created —
co-extract updates its content **and its `diff.after` + `overlayFiles` content in lockstep**, so
the §2.8 typecheck validates exactly the bytes that get written (the `sLegacy` import + repointed
refs resolve). The existing dry-run / §2.8 gate / dirty-gate / `commitMove` / pre-op
`revertMove` (spec-refactor-port §2.8–2.10) handle them **unchanged**. **Caveat (load-bearing):
`.scss` is not in the TS program, so the §2.8 typecheck cannot validate a class move** — the
correctness guarantee is co-extract's own safety proof + the structural oracle (§3), not the
gate. (Exactly the type-blind lesson from the aliased-scss fix.)

### 2.7 The safety taxonomy — ported verbatim (hard-won)

A class is **safe to move** only when ALL hold; otherwise it stays, tagged with the first
failing code. Port `classSafetyVerdict` / `selectorIsOwnedBy` / `selectorReferences`
essentially as-is — these are the killed bugs of CSS refactoring; re-deriving the heuristic
re-opens them.

| Code          | Meaning (leave-behind reason)                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USED`        | still referenced by the source-file remainder (or the remaining-source wildcard fired)                                                                                      |
| `NO-RULE`     | no rule found whose selector is _owned by_ this class                                                                                                                       |
| `COMPOUND`    | the class appears in a compound/descendant/sibling selector elsewhere (`.X.Y`, `.outer .X`)                                                                                 |
| `NESTED`      | the owning rule has nested child rules                                                                                                                                      |
| `NEST-PARENT` | the owning rule is itself nested inside another selector                                                                                                                    |
| `AT-RULE`     | the owning rule body uses an unsafe at-rule (`@include`/`@extend`/`@if`/`@for`/`@each`/`@while`/`@mixin`/`@function`/`@import`/`@use`/`@forward`/`@debug`/`@warn`/`@error`) |
| `SASS-VAR`    | a declaration references a Sass variable (`$foo`)                                                                                                                           |
| `EXTEND`      | some rule `@extend`s this class (tolerant of `!optional` + comma lists)                                                                                                     |
| `COMPOSES`    | the owning rule `composes:` another class, or another rule `composes:` this class (CSS-modules linkage that wouldn't travel)                                                |
| `KEYFRAMES`   | the owning rule animates a `@keyframes` defined in this sheet (the name is scoped per sheet, so it would dangle after the move)                                             |
| `PARSE-FAIL`  | the stylesheet couldn't be parsed / transformed — nothing could be proven, so nothing moves                                                                                 |
| `ALIAS-IMP`   | the CSS import in the TS code is path-aliased — sheet not resolved (§2.8)                                                                                                   |

**Ownership rule** (port exactly): a rule is _owned by_ `.X` only if every branch of its
selector list is `.X` optionally followed by pseudo-chains (`.X`, `.X:hover`, `.X::before`,
`.X:focus-visible`) — **not** `.X.modifier`, `.outer .X`, or `.X.Y`. Selector lists `A, B, C`
are owned only if **every** branch is owned. Carry each moved rule's immediately-preceding
comment siblings along.

### 2.8 Aliased CSS imports → `ALIAS-IMP`, resolve nothing

`ts.cssModuleUsages`' `resolveRelative` returns `undefined` for non-relative specifiers, and
co-extract's sheet discovery is relative-only. A source importing `@/styles/x.module.scss` →
report `ALIAS-IMP` for that sheet and move nothing (front-renamer's exact stance). (The
`move_file` op resolves aliased scss for rewrite-on-move — a different concern; resolving
aliased sheets _for co-extract_ is a future option, not v1.)

A second, narrower edge: one source file importing the **same** sheet under two local
bindings (`import s from './x'; import t from './x'`), where the extracted block uses `s.foo`
and the remainder uses `t.foo` (the _same_ class via the other binding). The shared-sheet scan
keeps a remainder class the extracted block doesn't reference, but a class used by **both** —
under different bindings — can't be told apart from the extracted block's own usage (the usage
scan carries no local-binding identity), so `foo` could still move. Rare; closes with
per-binding usage identity. Until then, same as above: disclosed, not silent.

The same relative-only limit bounds the **shared-sheet safety check** (`stillUsedClasses`):
the "is this class used by another importer?" scan (`cssModuleUsages().byModule`) sees only
files importing the sheet **relatively**. A third file importing the _same_ sheet via an
**aliased** specifier is invisible, so a class only it uses could be moved out from under it —
a type-blind break no gate catches. This is the same repo-wide gap as `find_unused_scss_classes`
and closes with `plugins/ts/module-resolve` (aliased scss resolution). Until then it is
**disclosed, not silent**: the `extract_symbol` notes tell the agent to verify aliased importers
of a shared sheet. Conservative-and-honest: the limitation is stated, never papered over.

## 3. Honesty & output (§3, §12)

The op's envelope gains `cssCoExtract?: CssCoExtractReport[]`, one per source stylesheet:
`{ sourceStylesheet, targetStylesheet, moved: string[], leftBehind: [{ class, code, detail?,
reason, span? }] }` (a left-behind class declared at a sheet rule carries a `span` proof of its
declaration — spec-scss-css-honesty Stage 4; `USED`/`NO-RULE` carry none). Rendered in the §12 house style — per-sheet `moved:` / `left:` lines with the
short codes + a one-line legend (front-renamer's report **is** the house style §12 credits).
A moved class is a `certain` proven claim; a left-behind class carries its reason, never a
guess. If the sheet fails to parse → every candidate is left behind with an honest note,
never moved (§3.6). An empty `moved` + empty `leftBehind` is still emitted when the block
referenced classes (so "we looked and found nothing to move" ≠ "we didn't try").

## 4. Stages (PR-sized; each `fix-and-check` green + an independent oracle, §16)

- **Stage 1 — `scss.classifyForExtract`** (taxonomy, read-only over the CST). Oracle: a
  fixture per code (compound → `COMPOUND`, nested → `NESTED`, `@extend` → `EXTEND`, `$var` →
  `SASS-VAR`, owned-clean → safe, …) asserted against an independent hand-classification. No
  moving yet.
- **Stage 2 — `scss.extractRules`** (clone-safe / remove-from-source / serialize, pure).
  Oracle: cold reparse both outputs — moved rules present in the new sheet & absent from the
  source, leading comments carried, untouched rules byte-stable; covers `.scss` and
  `.module.css`.
- **Stage 3 — TS block-scoped usage + wildcard + shadow-awareness**
  (`plugins/ts/refactor/extract/css-usage.ts`). Oracle: fixtures — extracted block uses
  `s.a`/`s.b`, remainder uses `s.b` → `b` is `USED`; remainder spreads `{...s}` → wildcard
  (all left); a `(s) => s.x` lambda shadow is **not** counted.
- **Stage 4 — op wiring + the `css: 'copy-safe'` flag.** The co-extract helper joins 1–3,
  emits the plan additions (new sheet, edited source sheet, rewritten extracted file with the
  `sLegacy` import + repointed refs), threads the report into the envelope. Oracle (git-backed,
  end-to-end): extract a component whose sibling `.module.scss` mixes safe + unsafe classes
  (compound, nested, `@extend`, a still-used-in-remainder one); assert the moved set is
  **exactly** the provably-safe classes, the new sheet holds them, the source keeps the rest,
  the extracted file imports both `s` and `sLegacy` with left-behind refs on `sLegacy`,
  **post-apply `tsc` clean** (the `.tsx` compiles), and the per-class report codes match an
  independent classification. Because scss is type-blind, the class-resolution correctness is
  asserted **structurally** (the moved class exists in the new sheet; the left-behind ref
  resolves via `sLegacy`), not via `tsc`.

## 5. Module layout (as built)

```
plugins/scss/
  parse-root.ts         parse a sheet → postcss[-scss] CST Root (shared by classify + rules)
  extract-classify.ts   the §2.7 taxonomy (selector ownership, at-rule/sass-var/@extend)
  extract-rules.ts      clone-safe / remove-from-source / serialize (postcss[-scss])
  plugin.ts             + classifyForExtract / extractRules on ScssPluginApi
plugins/ts/refactor/extract/
  css-usage.ts          block-scoped, scope-aware s.X usage + remaining wildcard; the
                        scope-aware sLegacy rewrite (exposed as ts.rewriteExtractedCss)
  move-to-file.ts       builds plan.cssExtract (§2.3 analysis) when css is requested
plugins/ts/
  ls-host.ts            the §4 patched-LS rescue: a fallback LS from the fork, version-gated
ops/
  extract-css-coextract.ts   the join (ts usage → scss classify/extract → ts rewrite → fold)
  extract-symbol.ts          + the `css: 'copy-safe'` flag, runs the join, threads the report
```

## 6. Open questions / risks

- **scss plugin gains its first transform surface** — acceptable because `extractRules`
  returns strings (pure); the op owns the write. Confirms §5-L2 (the plugin transforms its
  domain; the op does I/O). If a future caller wants in-place scss edits, that's a separate
  mutating-op decision.
- **Type-blind correctness** — the §2.8 gate cannot vouch for a class move; the oracle must be
  independent (cold reparse + structural class-resolution), never tsc-only. State this in the
  Stage-4 test.
- **Multiple CSS-module imports per file** — handle per-import (front-renamer loops); a sheet
  whose import is aliased → `ALIAS-IMP`, the others still processed.
- **Dynamic access anywhere on a sheet's binding** (`s[expr]`) → wildcard → leave all (already
  the conservative stance; matches `cssModuleUsages`' `dynamic` confidence).
- **Pre-existing gap surfaced** — `scanCssModuleUsages` (`css-modules.ts`) is not scope-aware
  (a shadowing lambda param pollutes `find_unused_scss_classes`). Out of scope here, but the
  block analysis (§2.3) must be scope-aware regardless; consider back-porting the shadow skip
  to `scanCssModuleUsages` as a follow-up (file via `feedback`).

```

```
