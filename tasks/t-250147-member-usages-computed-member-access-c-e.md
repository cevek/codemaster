---
id: t-250147
title: 'member_usages: computed member access c[expr] is not per-site traced — v1 emits a disclosure note only'
status: backlog
priority: low
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-08T19:29:03.069Z'
---
Deferred from t-000175 v1. A computed element access (c[expr] where expr is not a string literal) is silently dropped by the LS; member_usages discloses this with a scope note (honest under-coverage) but does NOT flag each computed site. A bounded per-site syntactic scan for computed member accesses of the target member (mirroring the discrimination_sites computed-scrutinee precedent) would flag each as dynamic instead of a blanket note. fix-locus: src/plugins/ts/member-usages.ts.
