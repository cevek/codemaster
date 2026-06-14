# Spec: scss / css-module honesty hardening (inbox triage)

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §3 (trust
contract — esp. §3.2 proof-carrying, §3.3 confidence, §3.4 no-silent-completeness), §4 (the scss
parser cell), §16 (honesty harness); `docs/spec-css-coextract.md`, `docs/spec-synthetic-fixture.md`
(§4.3.1 selector zoo); and CONTRIBUTING.md before starting. Refines the inbox `[wish]` items dated
2026-06-14.

## 1. Purpose

Building the kitchensink trap-zoo and the CSS co-extract surfaced **three scss / css-module honesty
gaps** where codemaster currently either **lies** (reports a class as definitely unused when it
isn't) or forces a **re-grep** (an unverifiable claim with no proof span). The kitchensink trap
tests already pin these as KNOWN GAPS (`test/e2e/kitchensink-traps.test.ts`, §4.3.1) — this spec
fixes the plugin so those tests flip from "documents the gap" to "asserts the honest behavior."

All three live in the scss / css-usage domain (the `scss` plugin + `plugins/ts/css-modules.ts` +
the co-extract report), so they're one coherent task.

## 2. Fixed decisions

- **Reuse, never duplicate (copy-paste contract).** The scope-aware shadow helpers (#3) already
  exist as **unexported internals** in `src/plugins/ts/refactor/extract/css-usage.ts`
  (`extendShadow` / `shadowsFrom` / `collectBoundNames` / `functionLikeParameters`). Extract them to
  a **shared module** (e.g. `src/plugins/ts/scope-shadow.ts`) and consume from **both** `css-usage.ts`
  and `css-modules.ts` — do not copy them, and do not stand up a second traversal. Similarly the
  contextual/nested/compound classification (#2a) already lives in
  `src/plugins/scss/extract-classify.ts` (COMPOUND/NESTED/AT-RULE/NEST-PARENT verdicts) — `find_unused`
  must reuse that notion of "entangled / not provably owned," not re-derive selector parsing.
- **Honesty over completeness (§3.3/§3.4).** "Could not prove dead" is `partial`, never `certain`
  unused. A `:global` class is not a module-local class. A claim without a proof span the agent must
  re-verify is a trust leak (§3.2).
- **No behavior invented — match the kitchensink §4.3.1 expected behavior**, which is already
  written down; flip the KNOWN-GAP assertions to positive ones.

## 3. Stages

**Definition of done per stage** (§17 + CONTRIBUTING): `fix-and-check` green · an **oracle-backed**
test (cold reparse / independent scan — §16) · the matching kitchensink KNOWN-GAP test flipped to
assert the fix · ≤300 real-code lines/file · no upward import · no duplicated traversal · docs at
present state.

### Stage 1 — `find_unused_scss_classes`: contextual classes are `partial`, not `certain` unused; dedup

- **Gap (#2a).** A class that appears ONLY inside a contextual / nested / compound / at-rule /
  parent-ref selector (`.card .row`, `.card>.head`, `.card{ .nested }`, `.card{ &.active }`,
  `[data-theme]{ .themed }`, `@media{ .responsive }`) is reported `confidence:'certain'` unused. Per
  §4.3.1 these are **not provably unused** → must be `partial` ("could not prove dead"), never
  plainly unused. Also: the same class seen in N selectors emits **N duplicate rows** — collapse to one.
- **Build.** Reuse `extract-classify.ts`'s verdict notion (a class with no top-level owning rule but
  referenced in a compound/contextual selector is entangled). In `find_unused`, demote such a class to
  `partial` with a note (mirror the existing dynamic-access `partial` demotion); dedup the result by
  class+file.
- **Oracle.** Flip the kitchensink §4.3.1 KNOWN-GAP assertion: `row/head/nested/themed/responsive` →
  `partial`, single row each; a genuinely-dead simple class stays `certain`. Independent class scan.

### Stage 2 — `scss_classes`: synthesize BEM parent-ref concat names; exclude `:global`

- **Gap (#2b/#2c).** `.block { &__el {} &--mod {} }` yields only `block`, not `block__el`/`block--mod`
  — so a TS access `s['block__el']` can't match. And `:global(.escapeHatch){}` is listed as a
  module-local class (it isn't — `:global` breaks out of module scope). (Attribute-only top-level
  rules are already correctly ignored — keep that.)
- **Build.** In the scss parse (`parse.ts` / the class extractor): resolve parent-ref `&`
  concatenation (`&__el` → `<parent>__el`, `&--mod`, `&.x`) so the synthesized class name is emitted
  with the right span; exclude selectors inside `:global(...)` from the module-local class set.
- **Oracle.** kitchensink zoo: `block__el`/`block--mod` now listed (and matchable by `s['block__el']`);
  `:global` class NOT listed by `scss_classes` nor `find_unused`. Cold reparse.

### Stage 3 — `scanCssModuleUsages`: scope-aware shadow skip

- **Gap (#3).** `scanCssModuleUsages` (`css-modules.ts`) records `s.X` / `s['X']` over the WHOLE file
  with no scope awareness, so a lambda/catch/destructuring binding that **shadows** the css-module
  import name (`useStore((s) => s.field)`, `rows.map((s) => s.foo)`) is mis-counted as a class access
  — polluting `find_unused` (a shadowed `s.field` reads as "class used").
- **Build.** Extract the shadow helpers from `css-usage.ts` to a shared module (§2); make
  `scanCssModuleUsages` skip the subtree under any binding that shadows the import name.
- **Oracle.** A fixture where a lambda param shadows the css-import binding → the shadowed access is
  NOT counted; a genuine `s.real` outside the shadow still counts. Cold check + the existing
  css-usage tests stay green (shared helper unchanged in behavior).

### Stage 4 — co-extract `leftBehind`: proof-carrying spans

- **Gap (#4).** Each `leftBehind` entry carries `{class, code, detail?, reason}` but **no `file:line`
  span** — so a `COMPOUND`/`NESTED`/`EXTEND`/`SASS-VAR` claim is unverifiable without re-opening the
  sheet (the exact re-grep §3.2 exists to eliminate). `moved[]` is verifiable from the diff;
  `leftBehind` is not.
- **Build.** Thread the owning rule's / class declaration's `Span` (postcss `rule.source.start`,
  already in the CST; `scss.classes(file)` also exposes class spans) into each `leftBehind` entry
  **where the class is declared in the sheet**. `USED` / `NO-RULE` have no clean single sheet span —
  leave `span` absent there **honestly** (don't fabricate).
- **Oracle.** A co-extract test asserts each spanned `leftBehind` entry's span equals the source-sheet
  rule location (assertSpansValid-style: the text at the span is that class's rule); `USED`/`NO-RULE`
  carry no span.

## 4. Review protocol

- **bug-reviewer** — the false-`certain`-unused is gone (a contextual-only class is `partial`); the
  shadow skip doesn't over-skip a real access; a `:global` exclusion doesn't drop a real module class;
  every emitted `leftBehind` span's text matches the source (§16 inv.1).
- **copy-paste-reviewer** — the shadow helpers are **shared**, not duplicated, between `css-usage.ts`
  and `css-modules.ts`; `find_unused` reuses the classifier's verdict, not a second selector parser.
- **doc-sync-reviewer** — the kitchensink §4.3.1 KNOWN-GAP comments are updated to present state; the
  inbox items can be marked resolved.
