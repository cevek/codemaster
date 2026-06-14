# Spec: the synthetic "kitchensink" fixture — a dense trap-zoo for the honesty harness

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §16 (honesty
harness), §3 (trust contract), §4 (parser-per-domain), §19 (platform) and `test/README.md`
before starting.

## 1. Purpose

A single committed mini-project under `test/fixtures/repos/kitchensink/` whose only job is to
pack the **maximum density of structural variety** codemaster must not lie about — into one
hermetic, typecheck-clean tree. It has **no meaningful business logic**: every function/class is
a structural stub. The value is entirely in the _shapes_ — import styles, export forms,
call-site tangle, style-dialect mix, i18n patterns.

It is the **realistic integration substrate** that read-core integration/smoke tests and the
Phase 2 port's high-blast-radius `move_file`/`extract_symbol` tests both operate over. It does
**not** replace focused inline `project({…})` fixtures: a single invariant pinned against an
oracle is still clearer in a 3-file inline fixture. The split:

- **Inline `project({…})`** — one trap per test, isolating a single invariant + its oracle.
- **kitchensink** — realistic blast radius (rename/move across many importers), cross-op
  consistency, a dense `status`/`find_usages`/`scss_classes`/`i18n_lookup` smoke, and the place
  where "many call sites of one symbol" is real.

NDA-safe by construction: neutral names, no copied code, no domain logic — it only mirrors the
_shapes_ real projects exhibit.

## 2. Non-goals

- No business logic, no runtime behavior anyone depends on. Stub bodies return dummies.
- Not a monorepo in v1 (per-package Programs are deferred in the `ts` plugin — root `tsconfig`
  only today). A second package / project-references is a **deferred axis** (§7), add it when
  per-package Programs land.
- Not a place for **broken TypeScript**: the TS must typecheck clean (§3). Parse-failure /
  syntax-error TS cases live in separate small inline fixtures, never here. (One deliberately
  malformed `.scss` is allowed — it is not in the TS program and the `scss` plugin surfaces parse
  failures per-file; §5.)

## 3. Hard constraints (the acceptance gates)

1. **`tsc --noEmit` clean, with no `npm install`.** Ambient stubs supply every external module
   (`react`, `*.module.scss`/`*.module.css`, side-effect style imports). Reuse the
   `test/fixtures/_typings/` stub mechanism. A tangled graph is fine; broken types are not.
2. **Deterministic & hermetic.** No timestamps, no randomness, no network. Loaded by a helper
   that copies the tree to a temp dir and `git init`s it (mirroring `project()`), so git-backed
   oracles (dirty gate, `git mv` history, byte-exact rollback) work — see §6.
3. **Neutral, NDA-safe names.** `featureA`, `WidgetCard`, `formatLabel`, `core/registry` — never
   anything domain-specific.
4. **Every trap is intentional and labeled.** A short top-of-file comment on each file states
   _which trap(s) it carries and which op/invariant it serves_, so a future cleanup can't
   "simplify" a trap away without noticing. A trap-presence self-test (§6) enforces this.

## 4. The trap matrix (the meat — hit every row, respect the minimums)

> Minimums exist to force genuine density — a token example per axis is not enough. "Serves"
> names the op/invariant the trap exercises.

### 4.1 Module resolution & import/export variety

| #   | Trap                                                                                                                                                                                                                  | Minimum                                                                     | Serves                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Relative imports (`./`, `../../`) **and** alias imports (`@/…` via tsconfig `paths`)                                                                                                                                  | both used; ≥1 target imported via alias in one file and relative in another | `find_usages`, `importers_of`, `move_file` import-rewrite                                                                                                                                                                                       |
| M2  | Barrel re-export (`export * from`, `export { X } from`)                                                                                                                                                               | ≥1 barrel `index.ts`                                                        | re-export role split, move                                                                                                                                                                                                                      |
| M3  | Re-export **with rename** (`export { A as B }`) and import-with-rename (`import { Foo as F }`) used as `<F/>` **and** `F()`                                                                                           | ≥1 each                                                                     | aliased-usage (grep-beating), rename                                                                                                                                                                                                            |
| M4  | **Deep re-export chain** (decl → barrel → barrel → consumer, ≥3 hops) + a symbol consumed via **both** the hub and the deep path (two valid paths to one symbol)                                                      | ≥1 three-hop chain; ≥1 dual-path symbol                                     | the "renamed-through-3-barrels" trap; rename must update regardless of which path each consumer used; `find_usages` must resolve through `export *`                                                                                             |
| M5  | Namespace import (`import * as NS`) + member call `NS.foo()`                                                                                                                                                          | ≥1                                                                          | find_usages through namespace                                                                                                                                                                                                                   |
| M6  | Default export + default import; mixed default+named                                                                                                                                                                  | ≥1 default export consumed                                                  | move, rename                                                                                                                                                                                                                                    |
| M7  | Type-only import (`import type {T}`) + inline (`import {type T, val}`)                                                                                                                                                | ≥1 each                                                                     | type-only role, find_usages value-vs-type                                                                                                                                                                                                       |
| M8  | **Import cycle** (A↔B)                                                                                                                                                                                                | ≥1 cycle                                                                    | must not hang/lie; reindex correctness                                                                                                                                                                                                          |
| M9  | Dynamic `import()` of a module, incl. a **string-keyed `React.lazy` registry** (`lazy(() => import('./X').then(m => ({default: m.Y})))`)                                                                              | ≥1 plain + ≥1 registry entry                                                | dynamic flag; **`move_file` must rewrite the dynamic `import('./X')` specifier**; the registry is the **honest-limitation** case — a symbol rename can't reach a string path, must be flagged (mined: a 172-entry registry)                     |
| M10 | Side-effect-only import (`import '@/styles/base.scss'`)                                                                                                                                                               | ≥1                                                                          | css side-effect, move                                                                                                                                                                                                                           |
| M11 | **Dual-spelling import** — the _same_ `.ts`/`.tsx` file imported both **with** the extension (`@/lib/x.ts`) **and without** (`@/lib/x`), both valid under `moduleResolution:"bundler"` + `allowImportingTsExtensions` | both spellings of ≥1 file, ideally a high-fan-in one                        | **mined from a real repo** (283 importers of one module, mixed spellings). Read side: `importers_of` resolves both to one set (verified). **`move_file`/`rename` must rewrite BOTH spellings** or leave half dangling — a port Stage F stressor |
| M12 | **`import('…').Type` type-query** — a type referenced via the `import(...)` type operator in a type position (`x?: import('@/data/shapes').Foo`), **not** an ES import statement                                      | ≥1, in a signature                                                          | **mined from a real repo (353 uses).** Needs TS-AST resolution; `move_file`/`rename` must rewrite **both the embedded path and the symbol** — ES-import analysis alone misses it entirely                                                       |

### 4.2 TS symbol & call-site tangle (make this genuinely dense)

| #   | Trap                                                                                                                                                                                                                                                                                                             | Minimum                                                                 | Serves                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | A `core/` layer: functions, arrow fns, classes (methods, static methods, getter/setter, fields), generics, an `enum`, `const enum`, union types, interfaces, a type alias                                                                                                                                        | ≥6 functions, ≥3 classes, ≥1 generic, the enum/union/alias each present | `expand_type`, `search_symbol`, `find_definition`                                                                                                                                                                                                      |
| T2  | **High fan-in symbol** — one function called from ≥6 sites across ≥4 files                                                                                                                                                                                                                                       | exactly that                                                            | `find_usages` blast radius; `change_signature`                                                                                                                                                                                                         |
| T3  | **High fan-in class** — instantiated in ≥5 files; a method called via instance, via destructure, via `this`                                                                                                                                                                                                      | exactly that                                                            | rename, move                                                                                                                                                                                                                                           |
| T4  | **Same-name collisions** — a name (`handle`) exported from two modules + a local `handle` elsewhere (3-way)                                                                                                                                                                                                      | ≥1 three-way collision                                                  | the trap grep can't disambiguate; rename must target one                                                                                                                                                                                               |
| T5  | Indirect call via variable (`const f = foo; f()`) and callback passing (`run(foo)`)                                                                                                                                                                                                                              | ≥1 each                                                                 | dynamic-ish dispatch, confidence                                                                                                                                                                                                                       |
| T6  | Overloaded function (≥2 signatures); merged declaration (namespace + function, or interface merge)                                                                                                                                                                                                               | ≥1 each                                                                 | find_definition, expand_type                                                                                                                                                                                                                           |
| T7  | A symbol used **only in a type position** vs one used only as a value                                                                                                                                                                                                                                            | ≥1 each                                                                 | value/type role honesty                                                                                                                                                                                                                                |
| T8  | JSX usage: `<Comp/>`, namespaced `<NS.Sub/>`, spread props `{...p}`, computed/literal props                                                                                                                                                                                                                      | each present                                                            | find_usages JSX, react later                                                                                                                                                                                                                           |
| T9  | A symbol that will be **moved** (rebind `rebound`) and one that will be **deleted** (rebind `gone`) — leave clear anchors                                                                                                                                                                                        | ≥1 each                                                                 | §6 rebind tests                                                                                                                                                                                                                                        |
| T10 | **String-literal-union-as-enum** — a discriminated `type Status = 'a'\|'b'\|'c'` used as a de-facto enum: narrowed via type guards / `switch` across many sites, indexed (`labels[status]`), with **parallel `Record<Status, V>` lookup tables** (+ a `satisfies`) that must stay in sync when the union changes | ≥1 union, ≥4 narrowing sites, ≥2 parallel `Record` tables               | the modern erasable-syntax reality (mirrors OpenAPI-generated unions; mined: 235 unions, 732 `Record<K,V>`); `find_usages`/`expand_type`/`change_signature` on a union arm. **Keep a real `enum` too** (T1) so `expand_type`'s enum path stays covered |
| T11 | **`.d.ts` module augmentation** — `declare module 'pkg' { … }` ambient augmentation (e.g. an i18n loose-key signature)                                                                                                                                                                                           | ≥1                                                                      | ambient modules are **not movable files** — `find_usages`/`move_file` must handle the augmentation honestly, not treat it as a relocatable symbol                                                                                                      |
| T12 | **Large monolithic file** — one file with many deeply-nested local helpers + local types + closures, and an **extract anchor**: a nested helper that captures outer-scope types/vars                                                                                                                             | ≥1 file ~500–800 lines, ≥1 nested extract target with closure capture   | mined from a real repo (10k-line files, 80+ symbols). Stresses `extract_symbol` scope analysis (port Stage G): the extracted symbol's outer-scope type/closure deps must move or import correctly, never silently break                                |
| T13 | **`const enum`** with members referenced across files                                                                                                                                                                                                                                                            | ≥1 const enum, refs in ≥2 files                                         | mined from a real repo (94 generated const-enum files). `const enum` members are **inlined** (no runtime object) — `find_usages`/`rename`/`expand_type` must handle member refs through inlining, not assume a runtime enum object                     |

### 4.3 Style dialects & connection styles — pin codemaster's _honest_ behavior

> The `scss` plugin parses **only `.scss`** (postcss-scss CST, syntactic); the cross-tier
> css-module detector accepts `.scss` **and** `.css` specifiers; `.sass` is unsupported
> everywhere. Include every dialect _and_ every connection style so the tests pin what codemaster
> parses vs what it must be _honest_ about not covering — never claiming coverage it lacks.

| #   | Trap                                                                                                                                                                                                                         | Minimum                        | Serves / expected honest behavior                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `*.module.scss` as a **CSS module** (`import s from './x.module.scss'`), sibling-colocated with a `.tsx`                                                                                                                     | ≥2 distinct modules            | full parse; sibling-carry on move/extract                                                                                                                                                                           |
| S2  | The **same dialect connected both ways**: a `*.module.scss` imported as a module **and** a `.scss` pulled in as a bare **side-effect** (`import './g.scss'`, no binding)                                                     | both styles present            | module-vs-side-effect distinction — only a module's classes are usage-trackable                                                                                                                                     |
| S3  | **Several `.module.scss` imported into one `.tsx`** (e.g. `s` + `layout` + `theme`), classes accessed from each binding                                                                                                      | ≥1 file with ≥3 module imports | per-binding resolution; correct cross-module usage attribution                                                                                                                                                      |
| S4  | **Bidirectional unused/missing across ≥2 modules:** classes **declared in scss but never used in TS** (unused) **and** `s.foo` **referenced in TS with no scss rule** (missing / NO-RULE) — both directions                  | each direction in ≥2 modules   | `find_unused_scss_classes` unused-honesty + missing/NO-RULE honesty                                                                                                                                                 |
| S5  | CSS-module **access patterns** in one module: static `s.foo`, literal-computed `s['foo']`, **dynamic** `s[expr]`, **missing** `s.ghost`                                                                                      | all present                    | dynamic→`partial` (demotes that module's unused-claims); missing honesty                                                                                                                                            |
| S6  | `*.module.css` CSS module imported and accessed                                                                                                                                                                              | ≥1                             | **partial trap**: usage detected (ts), classes **not** parsed (scss) — pin the gap                                                                                                                                  |
| S7  | `.sass` (indented) imported somewhere                                                                                                                                                                                        | ≥1                             | **unsupported trap**: detected by nothing — must not list its classes                                                                                                                                               |
| S8  | Plain global `.css` side-effect import                                                                                                                                                                                       | ≥1                             | side-effect handling, move                                                                                                                                                                                          |
| S9  | `@use` / `@forward` cross-module; `@include` mixin; `@extend .x`; interpolated selector `.icon-#{$n}`                                                                                                                        | each present                   | cross-`@use` orphan check → `partial` (§19); interpolation → `partial`; `@extend`/`@include` → unsafe                                                                                                               |
| S10 | One **deliberately malformed** `.scss` (unclosed block)                                                                                                                                                                      | exactly 1, labeled             | scss parse-failure surfaced honestly, per-file, **TS program unaffected**                                                                                                                                           |
| S11 | **`:global(...)` break-out** + **attribute-only top-level selectors** (`[data-slot='x'] {}`, no class)                                                                                                                       | ≥1 each                        | mined from a real repo (`:global` ×21, `[data-*]` ×200+). A `:global(.x)` class and an attribute-only rule are **not** module-local classes — `scss_classes`/`find_unused_scss_classes` must not list them as `s.x` |
| S12 | **`composes:`** CSS-modules composition (`.b { composes: a; }`)                                                                                                                                                              | ≥1                             | `s.b` pulls in `.a` — `.a` is **used via composition**; `find_unused_scss_classes` must count it used or honestly `partial`, never plainly "unused"                                                                 |
| S13 | **Computed / indirection class access (two variants):** (a) template-literal-prefix ``s[`variant-${k}`]`` matching `.variant-a`/`.variant-b`; (b) **indirection map** `const m = { a: s.alpha, b: s.beta } as const; m[key]` | both                           | mined from a real repo. (a) → **dynamic/`partial`** (which class unprovable); (b) the `s.alpha`/`s.beta` are **static refs in the map literal** → must be counted **used**, never falsely "unused"                  |

### 4.3.1 Selector-shape zoo — maximize the "unsafe" classifications

> The CSS co-extract safe-move analysis (port Stage G) **and** `find_unused_scss_classes` honesty
> both hinge on selector _shape_. A top-level single-class rule is provably safe and cleanly
> attributable; a contextual / nested / compound / at-rule selector is **not** — codemaster must
> classify it `unsafe` (leave it behind on co-extract) and treat its classes as
> **not-provably-unused** (`partial`), never falsely "unused" or "safe". Pack one of each shape so
> every code path fires. Spread these across the S1/S3 modules.

| Shape                       | Example                                        | Expected classification                                                                                              |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Simple single-class         | `.a {}`                                        | **SAFE** — cleanly attributable / movable                                                                            |
| Descendant combinator       | `.a .b {}`                                     | **unsafe** — COMPOUND/contextual (`.b` depends on `.a` ancestor)                                                     |
| Child / adjacent combinator | `.a > .b {}`, `.a + .b {}`                     | **unsafe** — contextual                                                                                              |
| Comma group                 | `.a, .b {}`                                    | **unsafe/ambiguous** — one rule declares multiple classes                                                            |
| Nested                      | `.a { .b {} }`                                 | **unsafe** — NESTED (`.b` scoped under `.a`)                                                                         |
| Parent-ref compound         | `.a { &.b {} }` → `.a.b`                       | **unsafe** — COMPOUND (both classes on one element)                                                                  |
| Parent-ref concat (BEM)     | `.block { &__el {} &--mod {} }` → `.block__el` | name-synthesis: `scss_classes` must extract `block__el`/`block--mod`; match against `s['block__el']`                 |
| Attribute-context           | `[data-x] { .a {} }`                           | **unsafe** — contextual under an attribute condition                                                                 |
| Attribute-only (no class)   | `[data-slot='x'] {}`                           | **not a class rule** — `scss_classes` lists nothing for it (the dominant real-world hook to style library internals) |
| Pseudo                      | `.a:hover {}`, `.a::before {}`                 | class `a` attributable; rule shape varies                                                                            |
| At-rule context             | `@media (...) { .a {} }`                       | **unsafe** — AT-RULE                                                                                                 |
| `@extend` / `@include`      | `.a { @extend .base; }`                        | **unsafe** — EXTEND / mixin                                                                                          |
| Interpolated                | `.icon-#{$n} {}`                               | **partial** — computed name, never guessed (SASS-VAR)                                                                |

### 4.4 i18n

| #   | Trap                                                                                    | Minimum     | Serves                                                    |
| --- | --------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| I1  | `locales/en.json` + a second locale (`ru.json`), nested dotted keys                     | both        | `i18n_lookup`                                             |
| I2  | `t('a.b')` static usage; `t(\`dyn.${x}\`)`dynamic;`t('absent.key')` used-but-undeclared | all present | static resolve; dynamic→flagged; `find_missing_i18n_keys` |
| I3  | A key declared but never used (orphan); a key present in `en` but missing in `ru`       | ≥1 each     | `find_unused_i18n_keys`, `find_missing_i18n_keys`         |

### 4.5 Confidence / dynamic surface (cross-cutting)

Ensure at least one of each lands somewhere above so the `dynamic`/`partial`/`unresolved` paths
have real inputs: computed css access (S5), interpolated scss selector (S9), template-literal
i18n key (I2), indirect/callback dispatch (T5), dynamic `import()` (M9).

## 5. Required scaffolding

- `tsconfig.json` — `strict: true`, `jsx: "react-jsx"`, `baseUrl: "."`, `paths: {"@/*": ["src/*"]}`,
  `noEmit: true`, `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`,
  `verbatimModuleSyntax: true`. (Bundler + `allowImportingTsExtensions` is what makes the M11
  dual-spelling real and forces `import type` for type-only imports — both live in real configs. Do
  **not** set `erasableSyntaxOnly` — keep `enum` testable for `expand_type`; the T10
  string-literal-union covers the erasable-style reality alongside it.)
- Ambient stubs (no `npm install`): `react` (minimal JSX), and module declarations for
  `*.module.scss`, `*.module.css`, `*.scss`, `*.css`, `*.sass`. Keep them in the fixture's own
  `types/` (or reuse `test/fixtures/_typings/`); state which.
- `locales/en.json`, `locales/ru.json`.
- A `codemaster.config.ts` (or the inline-config the loader injects) enabling `ts` + `scss` +
  `i18n` (i18n needs `locales`), so `status` lists all three plugins over this fixture.

## 6. How tests consume it + acceptance

- **Loader.** Add `test/helpers/repo-fixture.ts` → `projectFromDir('kitchensink')`: copy the
  committed tree to a temp dir, then the same `git init`+commit as `project()`; return the same
  `TestProject` interface. (Do **not** commit a nested `.git`.)
- **Acceptance gates (all must hold):**
  1. `tsc --noEmit` over the fixture is **clean** (the strong gate — a mis-built fixture fails here).
  2. `status` over the fixture lists `ts`, `scss`, `i18n` and the full op catalogue without error.
  3. A **trap-presence self-test** (`test/fixtures/repos/kitchensink/_traps.test.ts` or under
     `test/e2e/`) asserts each matrix row is actually present and behaves honestly — e.g.
     `find_usages` on the T2 high-fan-in symbol returns ≥6 sites across ≥4 files; `scss_classes`
     lists S1 classes (incl. the `&__el` BEM-concatenated name) but **not** S6 `.module.css` / S7
     `.sass` classes; `find_unused_scss_classes` reports a module carrying §4.3.1 contextual /
     nested / compound selectors as **`partial`** and never marks those classes plainly "unused";
     a class reachable only via a contextual selector is **not** in the clean-unused set; the S10
     malformed scss surfaces a parse-failure note; `find_missing_i18n_keys` flags the I2 absent
     key. This is the fixture's own regression net — it can't silently lose a trap.
  4. **Move / dual-spelling (M11):** `importers_of` on the M11 file resolves **both** spellings to
     one importer set (verified behavior); a later `move_file` test asserts **both** `@/lib/x.ts`
     and `@/lib/x` importers are rewritten — a rewriter that handles only one form leaves dangling
     imports.
- **The fixture is input, the oracle is independent** (§16): blast-radius/rename/move tests
  written _later_ against kitchensink still pin results against the cold LS / git / `tsc`, never
  against the fixture asserting about itself (beyond the trap-presence smoke).

## 7. File layout (sketch — the agent fleshes it out to hit the minimums)

```
test/fixtures/repos/kitchensink/
  tsconfig.json
  codemaster.config.ts
  types/            react.d.ts · styles.d.ts (*.module.scss|css, *.scss|css|sass)
  locales/          en.json · ru.json
  src/
    core/           registry.ts (classes) · format.ts (high-fan-in fn) · kinds.ts (enum/union/alias) · gen.ts (generics)
    shared/         index.ts (barrel, renames) · re-export chain (3 hops)
    features/
      widget/       Widget.tsx + Widget.module.scss (S1, sibling; selector-zoo §4.3.1) · @/core + relative · side-effect import './w.scss' (S2)
      dashboard/    Dashboard.tsx imports ≥3 modules: grid.module.scss + theme.module.scss + zoo.module.scss (S3) · bidirectional unused/missing (S4)
      panel/        Panel.tsx + panel.module.css (S6 partial) · import cycle with table/ (M8)
      table/        Table.tsx (cycle with panel) · legacy.sass (S7) · access patterns s.foo/s['foo']/s[expr]/s.ghost (S5)
      forms/        namespace import (M5) · dynamic import() (M9) · same-name `handle` (T4)
      misc/         overloads (T6) · type-only (T7) · move/delete anchors (T9)
    styles/         base.scss (@use/@forward/@extend/@include/interpolation S9) · theme.css side-effect (S8) · broken.scss (S10)
```

## 8. Open knobs (decide with the owner)

- **Name** — `kitchensink` is a placeholder; rename if preferred (`trap-zoo`, `synthetic`).
- **Size** — target ~25–40 source files. Dense enough to be a real graph, small enough to stay
  hermetic and fast. Push higher only if a perf/scale smoke wants it (separate concern).
- **Monorepo axis — deferred until per-package Programs (§9) land; then build it from this real
  shape.** A real webpack pnpm-monorepo (mined) exhibits: per-app `tsconfig`s with their own
  `baseUrl:"./src"` + `paths`, while the **root `tsconfig` has neither**; **webpack `resolve.alias`
  not mirrored in any tsconfig** (e.g. `helpers/*`); a shared package consumed via an **npm-alias →
  workspace symlink** (`"common":"npm:@scope/x@v"` + `node_modules/common → packages/common`); and
  **same-named per-app modules** (`helpers/analytics` in N apps). Empirically today
  (root-tsconfig-only): codemaster **resolves the npm-alias symlink correctly** (`importers_of`
  on `common/helpers/string` → the real `packages/common/…` file with all 189 importers — lock
  this in as a regression trap), but a **baseUrl-bare specifier conflates the distinct per-app
  modules** (`importers_of` on `helpers/analytics` → 32 importers across 9 apps grouped as one).
  The per-package-Programs work must resolve per-app or flag the ambiguity, **never silently
  conflate**. This is the monorepo fixture's spec when it lands.
- **Relation to the port** — kitchensink also serves the Phase 2 port's F/G blast-radius tests;
  the local-smoke-against-real-NDA-projects strategy (A) is a _separate_ port concern and should
  be recorded in `spec-refactor-port.md`, not here.
- **Provenance (NDA-safe).** These traps were **mined from real projects codemaster runs over** —
  live stressors, not hypotheticals — and recorded here only as abstracted shapes (neutral names,
  no proprietary code). From an SCSS-modules SPA: M11 (dual-spelling), S11–S13 (`:global` /
  `composes` / computed-indirection), T10 (union-as-enum), T11 (`.d.ts` augmentation). From a
  Tailwind SPA: M12 (`import('…').Type`, 353 uses), T12 (10k-line extract targets), the M4
  two-paths-to-one-symbol and M9 dynamic-specifier / lazy-registry notes. From a webpack
  pnpm-monorepo: T13 (`const enum` ×94) and the monorepo-axis shape above — where a dogfood check
  _refuted_ a hypothesis that codemaster fails on aliased imports (it resolves npm-alias symlinks
  correctly; it specifier-matches baseUrl aliases). Verified, not assumed.
- **Framework route-regen (optional axis, deferred).** Real file-based routers (TanStack) use
  special-char filenames (`__root.tsx`, `_layout.tsx`, `$param.tsx`) and a generated barrel
  (`routeTree.gen.ts`). `move_file` must handle unusual `RepoRelPath`s and **honestly flag** that
  it rewrites imports but cannot regenerate a generator's output. Add when the `tanstack-router`
  plugin (Phase 4) lands; until then a special-char-filename + generated-barrel move edge case can
  carry it.
