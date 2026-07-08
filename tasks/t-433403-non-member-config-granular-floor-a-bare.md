---
id: t-433403
title: 'Non-member config-granular floor: a bare (non-package) config with a git-tracked TS file OUTSIDE its include that nothing else globs can lift the floor over that orphan (config-granular vs directory-granular)'
status: backlog
priority: low
depends_on:
  - t-608842
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T16:23:11.408Z'
---
Flagged by t-228533 (pre-existing, not introduced by programs:; documented in code). Member coverage is DIRECTORY-granular (t-851482/t-232769: every git-tracked TS under a package dir must be covered, else floored + stray injection). A NON-member config (a bare nested tsconfig, no package.json) is judged on its OWN GLOB only, so a git-tracked orphan under its dir but outside its include, that nothing else globs, is unsearched yet does not keep the config floored -> loading it (via programs: OR auto-discovery) can lift the floor over the orphan = a narrow completeness gap. Identical for auto-discovered non-members; the member-orphan case IS handled via stray injection. Close by extending directory-granular coverage to non-member configs, or documenting the config-granular boundary. Related to the t-608842 fallback/coverage family.
