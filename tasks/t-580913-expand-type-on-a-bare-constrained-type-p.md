---
id: t-580913
title: expand_type on a bare constrained type-parameter (const y:T, <T extends Base>) now shows constraint members as OWN (was inherited)
status: backlog
priority: low
type: bug
complexity: S
area: correctness
source: dogfood-jul
created: '2026-07-08T12:37:11.406Z'
---
Spillover from t-754757's heritage-clause fix. A value typed as a bare constrained type-parameter (const y:T where <T extends Base>) now shows the constraint's members as OWN rather than (inherited), because a type-parameter's declaration carries no heritage clause. Derived hint only — member facts are correct; arguably MORE consistent (all no-heritage types → own). Rare, untested contract. Decide the intended semantic for constrained type-params. fix-locus: src/plugins/ts/type-expand.ts.
