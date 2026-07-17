---
id: t-442016
title: 'Reverse-capture resolve pre-filter: extend the sound skip to tail-preserving alias/bare specifiers'
status: backlog
priority: low
parent: t-031282
tags:
  - perf
  - ts-refactor
created: '2026-07-17T00:35:06.122Z'
---
A relative-only reverse-resolve pre-filter (`canSkipReverseResolve`: skip the FS-probing
`resolveModuleName` for a specifier whose last-segment basename can match no move-introduced file's
basename) was ATTEMPTED in t-000013 and **DROPPED** after adversarial review found sound
counterexamples — a skip that silently dropped a REAL reverse capture (the §7 worst case: a
type-compatible import re-bind apply proceeds with). Only the shared `ts.ModuleResolutionCache`
(lever 1) shipped. This task is the sound REATTEMPT.

Why lever 2 was unsound — the "a relative specifier resolves tail-preserving, so its resolved
basename equals its last segment" claim is FALSE for at least these relative-resolution mechanisms
(each verified end-to-end: `typecheck.clean`, HEAD reports 0 captures, skip-off reports the capture):

  A. NON-DOTTED `moduleSuffixes`. tsconfig `moduleSuffixes:["-mobile",""]`, `src/foo.ts` present,
     `./foo` resolves to `foo.ts`. Move `orphan.ts → src/foo-mobile.ts`; now `./foo` resolves to
     `foo-mobile.ts` (higher-priority suffix). Arrival basename `foo-mobile` ≠ specifier tail `foo`
     (strip-all-ext cuts at the first DOT, so a non-dotted suffix is not folded away) → skipped →
     dropped.
  B. BARE `..` / `.` directory imports. `import from '..'` resolves to `src/index.tsx`. Move
     `orphan.ts → src/index.ts` (`.ts` beats `.tsx`, no collision). Specifier `..` yields no
     `index`/parent-dir trigger form → skipped → dropped.

REQUIRED GUARDS (the reattempt must keep these RESOLVING, not skip): the two committed tests in
test/e2e/move-reverse-capture.test.ts — WILDCARD alias + MULTI-TARGET `paths` (tail-mismatch) — PLUS
new fixtures for A (non-dotted `moduleSuffixes`) and B (bare `..`/`.`). A sound skip must carve out:
non-wildcard `paths` keys, path values not ending in `*`, `exports`/`imports` (`#foo`) maps, ANY
`moduleSuffixes`, and bare-dir specifiers (`.`/`..`/trailing-slash). Consider also probing extension
priority across `.tsx/.jsx/.mjs` and `moduleResolution: bundler` vs node16 — the review that dropped
lever 2 did not enumerate those.

VALUE (why still worth doing): measured on backoffice2 (~6098 files, `move_file` dry-run) the
relative-only pre-filter cut distinct `resolveModuleName` calls 16839 → 10874 (−35%); on a
relative-import-heavy repo the win is larger. The cache alone already de-doubled the pass
(1826ms → ~612ms, resolveTotal 1654ms → 412ms), so this is incremental — do it only under FULL
adversarial soundness review.

DoD: byte-identical captures (all guard tests green) + adversarial soundness review + re-measure the
distinct-resolve count on an alias/relative repo. Territory: capture/**.
