# Task L — `css_cascade` op: resolved cascade / specificity for a CSS-module class

> Self-contained, FAT task (a net-new read op). Build on `main`. First: read `CLAUDE.md`,
> `ARCHITECTURE.md` §3 + §19 (SCSS analysis is syntactic — cross-`@use`/`@forward` is `partial`),
> call `status`, READ `src/plugins/scss/` (postcss-scss CST) and `scss_classes`/
> `find_unused_scss_classes` for the plugin/op shape.

## Why (the §7 deferred wish — the syntactic scss plugin can't answer it)

For a CSS-module class/element, "which rules actually target it across sheets, and who WINS per
property?" The current scss plugin is a syntactic CST — it lists declarations, not the resolved
cascade. The real trap it can't catch: a descendant/attribute/state selector in ANOTHER sheet
silently beating a local `.foo` across module boundaries. `css_cascade {class}` returns every rule
targeting it, ordered by specificity, with the winning declaration per property.

## Scope — IN

- New read op **`css_cascade { file+class (a CSS-module class), or a selector, pathInclude? }`**:
  resolve the rules across sheets that target the class/element, compute specificity, order them,
  and report the winner per property + the losers (so a cross-module override is visible).
- Honest `partial` where the resolution is genuinely uncertain — dynamic/state/attribute selectors,
  computed values, cross-`@use`/`@forward` boundaries the syntactic model can't fully resolve (§19).
  Never claim a resolved winner it can't prove. Proof-carrying spans to each contributing rule.
- Decide the resolution depth: a specificity model over the postcss CST is the floor; note where a
  real `sass`/dart-sass evaluation would be needed for computed values (keep that `partial`, don't
  pull in a heavy dep without cause — §14 lean-deps).

## Scope — OUT

- Computed-value evaluation requiring dart-sass (note as `partial`, defer). · mutation. · the
  `construction_sites` wish (Task K).

## Definition of done

- `fix-and-check` green; full suite 0 fail. Oracle-backed (hand-curated multi-sheet fixture, §16):
  a class targeted by a local rule AND a higher-specificity cross-module descendant/attribute rule —
  the op reports both, orders them by specificity, and names the cross-module winner per property;
  a dynamic/state selector is `partial`, not a false resolved winner. NOT golden-only.
- Honesty: proof-carrying, `partial` first-class for the syntactic model's limits, bounded, wrapped.
  Layering (extends the scss plugin with a resolved view; op composes it). Files ≤300. Self-describe
  in `status`. Dogfood live (amiro has scss modules).

## Files (likely)

`src/ops/css-cascade.ts` (new) · `src/plugins/scss/` (a resolved-cascade/specificity view) ·
`src/ops/builtins.ts` (register) · `src/format/` · status catalogue · tests.

## Parallel-run note

Independent, additive (read-only), isolated to the scss plugin + a new op. Shares only
`builtins.ts`/status golden with other new-op tasks (mechanical). Own worktree off `main`. Covers:
spec-stresstest-findings §7 `css_cascade`.
