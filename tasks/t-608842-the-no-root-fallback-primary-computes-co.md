---
id: t-608842
title: The no-root fallback-primary computes 'coverage' under WRONG options — the recurring root behind the multi-program honesty patches; stop counting fallback-globbed files as coverage (or synthesize a correct-options aggregate for a no-root repo)
status: done
priority: medium
type: imp
complexity: L
area: multi-program
source: dogfood-jul
created: '2026-07-08T13:42:48.569Z'
---
DONE (f5cd9fa) — root-addressed via CHECKER-ROUTING, not aggregate synthesis. The coverage-half was already honest (W6b computeCoverage excludes the fallback glob). The remaining root was the TYPE-AUTHORITY half: the no-config fallback primary served as type-authority under DEFAULT options (no paths/baseUrl) for type-producing reads. Fix: new host method typeAuthorityFor(abs) routes the 5 type-authority ops (expand_type / construction_sites / discrimination_sites / firstParamTypeMembers / wideningSinksAt) to the DEEPEST-ENCLOSING real-config program (deterministic via nearestConfig, pure over built() — NOT load order) that owns the file; rooted repos (configPath!=undefined) fall through to the primary = byte-identical. overlay-type stays primary-only (planning overlay per section 2.8); usages/unused-exports/coverage NOT routed (count honesty untouched). Verified: t-593802 fixed (member type un-polluted, cold-oracle match); claude-ui byte-identical (counts, complete=true); every committed test discriminates (revert routing -> fail). AGGREGATE-SYNTHESIS considered + REJECTED: routing achieves the type-authority honesty at far lower risk and without touching counts.
