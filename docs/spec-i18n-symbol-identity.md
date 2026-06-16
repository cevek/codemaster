# Task I — i18n: match by symbol identity (not name), + provenance + memo

> Self-contained, FAT task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §3, call
> `status`, READ `src/plugins/ts/literal-calls.ts` (the alias-aware scan), `src/plugins/i18n/` and
> the i18n ops (`i18n_lookup`, `find_unused_i18n_keys`, `find_missing_i18n_keys`).

## Why
Task F made i18n usage matching alias-aware but it is still **by NAME, module-blind** (plan.md F-b).
Config names only the FUNCTION (`t` / `i18n.t`), never its module, so the scan can't prove a `t()`
call targets THE i18n module. Two accepted-but-real residuals:
- **FALSE POSITIVE** — a `t` from a non-i18n module (`import { t } from './telemetry'; t('k')`, and
  its aliased form) matches by resolved name → a fabricated `find_missing` row / usage.
- **FALSE NEGATIVE** — a key reached only through a binding we don't follow (renamed destructure
  `const { t: x } = useTranslation()`, element access `i18n['t']`, `t` passed as a value, a renamed
  namespace import `import * as foo from '@/i18n'; foo.t()`) is missed → `find_unused_i18n_keys` can
  report a LIVE key as `certain` unused.

The real close (plan.md F-b): let config NAME the i18n module/hook, resolve the configured function
to ONE declaration, then match call sites by SYMBOL IDENTITY (like `find_usages`) instead of by
name. That kills the false positive AND the false negatives (incl. the namespace gap) in one model.

## Scope — IN
1. Config: a way to name the i18n module/hook (e.g. `i18n.module: '@/lib/i18n'` / `hook:
   'useTranslation'`) alongside the existing `functions`. Resolve it to the canonical declaration(s).
2. Rewrite the usage scan to match by symbol identity: a call site is an i18n usage iff its callee
   resolves (through imports/aliases/destructure/namespace) to that declaration. A same-named `t`
   from another module no longer matches; a renamed destructure/namespace alias of the REAL hook now
   does. Keep the honest dynamic-key handling (`t(\`x.${y}\`)` → `dynamic`/`partial`, never guessed).
   Keep a graceful fallback to the current by-name behaviour when config doesn't name a module (so
   existing setups don't regress).
3. **F-c provenance** (feedback wish 11:17): each `i18n_lookup` usage row carries how it was matched
   — `written` | `alias` | `destructure` | `namespace` (or the written callee text) — so the
   resolution is self-auditable and the honesty contract is legible.
4. **F-a memo** (plan.md): memoize `scanLiteralCalls`/the resolution keyed on `ts.freshness()` +
   config, invalidated on reindex — so a `batch` running several i18n ops doesn't re-scan per op.

## Scope — OUT
- ICU/plural semantics. · non-i18n ops. · multi-program visibility (Task G — though symbol-identity
  resolution composes with it).

## Definition of done
- `fix-and-check` green; full suite 0 fail. Oracle-backed (the i18n differential tests are the
  template): a non-i18n module's `t('k')` is NOT counted (false-positive closed); a renamed
  destructure / renamed-namespace usage of the real hook IS counted (false-negative closed); a
  dynamic key still demotes to `partial`; provenance is correct per row; the memo returns identical
  results to a cold scan (cold==warm). Update the op notes (drop the by-name caveat; state the
  symbol-identity model + its remaining honest edges).
- Honesty: a match is asserted only where identity is proven; uncertainty stays `partial`/`dynamic`.
  Layering (i18n plugin owns it; ops compose). Files ≤300. Dogfood live (amiro has i18n active).

## Files (likely)
`src/plugins/i18n/` · `src/plugins/ts/literal-calls.ts` (symbol-identity resolution + memo) ·
`src/ops/i18n-lookup.ts` / `find-unused-i18n-keys.ts` / `find-missing-i18n-keys.ts` (provenance +
notes) · `src/config/config.ts` (the i18n module/hook config) · tests.

## Parallel-run note
Isolated to the i18n plugin + its ops + config (shares only `builtins.ts`/status notes — mechanical).
Own worktree off `main`. Covers: feedback wish 11:17 (provenance); plan.md F-a, F-b, F-c.
