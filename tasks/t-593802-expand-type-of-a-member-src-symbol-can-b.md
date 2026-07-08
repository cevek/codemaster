---
id: t-593802
title: expand_type of a member src symbol can be polluted via the FALLBACK primary in a no-root repo (whole-repo glob under wrong options pulls in an augmentation stray)
status: done
priority: low
depends_on:
  - t-608842
type: bug
complexity: M
area: correctness
source: dogfood-jul
created: '2026-07-08T14:48:59.405Z'
---
Concrete instance of t-608842 (fallback-primary-under-wrong-options root). From t-232769: the injection vector for a declare-global/augmentation stray is GATED (pollution guard), but in a NO-root-tsconfig repo the fallback primary still globs the WHOLE repo incl such a stray → expand_type of a member src symbol can be polluted THROUGH the fallback (not through injection). Pre-existing, orthogonal to t-232769's fix. Resolved wholesale by the t-608842 root fix (stop treating fallback-globbed files as an authority / synthesize correct-options aggregate). fix-locus: the fallback primary's file-set + type-space.
