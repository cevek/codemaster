---
id: t-135997
title: importers_of does not distinguish "module resolved, 0 importers" from "module unresolved" — a bad module arg returns a silent importers(0) instead of a loud non-resolution (§3.6)
status: done
priority: medium
tags:
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-15T18:21:43.258Z'
---
**Repro (current main):** `importers_of {module:'NotARealPathXYZ'}` → `importers (0)` + `module=X`, with only the generic undiscovered-programs lower-bound note — NO explicit "module did not resolve" signal. The run-body cannot tell "resolved, genuinely 0 importers" from "spec never resolved to a file".

**Consequence (compounds the intake decision):** track A deliberately did NOT alias `query`/`name`→`module` for importers_of precisely because a symbol name routed into the module slot would silently return 0. That steer is loud only because intake rejects it up front; the run-body itself still has the silent-0 gap for any genuinely-unresolvable module path.

**Ask:** when the module specifier does not resolve to a file, say so explicitly (`module unresolved: X — pass a path under the repo`), distinct from an honest resolved-0. §3.6.

Source: track A codemaster feedback #1 (verified live) + DONE ⚑4. Related: t-954279 (importers_of intake decision).
