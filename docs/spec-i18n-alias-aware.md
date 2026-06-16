# Task F — i18n alias-aware usage resolution (close the `t as tr` blind spot)

> Self-contained task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §3 (honesty) +
> the i18n plugin, call `status`, READ `src/plugins/i18n/` and the i18n ops
> (`i18n_lookup`, `find_unused_i18n_keys`, `find_missing_i18n_keys`).

## Why

i18n usage matching is currently **by call name as written** — an `import { t as tr } from '@/lib/i18n'`
then `tr('common.save')` is MISSED (documented blind spot, but a real hole: it makes `find_unused_*`
over-report and `i18n_lookup` under-report). `find_usages` solved exactly this for TS symbols by
resolving imports semantically instead of matching call text; do the same for i18n.

## Scope — IN

- Resolve the configured translation function(s) through their IMPORT (incl. aliased
  `import { t as tr }`, and namespace/`i18n.t` member access) so a `tr('key')` call counts as a
  usage of `t`. Wire into the usage scan that feeds `i18n_lookup` (usage sites), `find_unused_i18n_keys`
  (the unused/partial verdict), and `find_missing_i18n_keys`.
- Keep the existing honesty: a DYNAMIC key (`t(\`errors.${code}\`)`) is still `unresolvable`/demotes
to `partial` — never guessed. The alias work resolves the FUNCTION, not the key.
- Update the op notes that currently document the alias blind spot (they become "resolved"); don't
  leave a stale "alias not recognized" caveat.

## Scope — OUT

- ICU/plural semantics. · non-i18n ops. · scale.

## Definition of done

- `fix-and-check` GREEN; full suite 0 fail.
- Oracle-backed test (the existing i18n differential tests are the template): an aliased
  `import { t as tr }` + `tr('common.save')` is recognized as a usage → the key is NOT reported unused
  and IS found by `i18n_lookup`; a namespace/`i18n.t('…')` call too; a dynamic `tr(\`x.${y}\`)`still
demotes to`partial`. Ground-truth vs a hand-curated fixture (NOT golden-only).
- Ethos: syntactic-but-import-resolved (state the provenance honestly); bounded; layering
  (i18n plugin owns this — ops compose it); files ≤300. Self-describe in `status` (drop the stale
  blind-spot caveat, add the resolved behavior). Dogfood live through the MCP (the amiro worktree has
  i18n active — verify on a real aliased import).

## Files

`src/plugins/i18n/` (the usage scan / import resolution) · `src/ops/i18n-lookup.ts`,
`find-unused-i18n-keys.ts`, `find-missing-i18n-keys.ts` (notes + behavior) · status catalogue · tests.

## Parallel-run note

Independent — isolated to the i18n plugin + its ops. Only shared touch is `builtins.ts`/status golden
notes (mechanical) with B/C/D. Own branch/worktree off `main`.
