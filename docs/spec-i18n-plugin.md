# Spec: the `i18n` plugin — locale keys, usages, missing/orphan checks

Status: **approved**. Third in this round's order:
[spec-cross-repo-root.md](spec-cross-repo-root.md) →
[spec-text-overlay.md](spec-text-overlay.md) → **this**. This is ARCHITECTURE §5/§17
Phase-3 work; the design there is binding, this spec pins the open details.

## 1. Problem

Field case: "does key `sales.tile.range.expected` exist, and where is it used?" went
to `python -c` + grep over JSON. Locale keys and `t('…')` usages are a domain with a
clean oracle (the JSON itself) — exactly what a plugin is for.

## 2. Fixed decisions

- **Enabled iff `config.i18n` is present** (no autodetection v1). Config section
  (zod, pointed errors): `locales` — glob or list of locale JSON files (the locale
  id derives from filename or parent dir, e.g. `locales/en.json` → `en`);
  `functions?: string[]` default `['t']`. (Present state: the implemented `I18nConfig`
  carries `locales` + `functions?` + a reserved `templateLiterals?`; `defaultLocale` was
  dropped — the three ops report missing keys per-locale across all locales, so no
  default-locale anchor is needed. Re-add it with the first op that requires one.)
- **The config gate lives in `pluginsFor`, NEVER in `opsFor`/`builtinOps()`.** The
  i18n ops are registered unconditionally with `requires: ['i18n']`; availability is
  gated by plugin presence (the engine already filters the catalogue and rejects
  dispatch by `requires`). Do not make the op list config-dependent: cross-root sql
  projects with the orchestrator's own op defs resolved from ONE root
  (`Orchestrator.opDefs`, spec-cross-repo-root) under the documented assumption that
  the op set is identical everywhere — a config-dependent `opsFor` would break the
  cross-root join for an op the owning engine actually has. Extend the §1.1
  anti-drift test run over `builtinOps()` to the new ops (it picks them up
  automatically — just don't bypass `builtinOps()`).
- **Parser: `ts.parseJsonText`** (the typescript package's position-carrying JSON
  AST). Proof spans must point into the locale file at `file:line:col`; plain
  `JSON.parse` has no positions. No new dependency. **Update the ARCHITECTURE §4
  parser table cell accordingly** (present-state rewrite).
- **Plugin state:** dotted-path flattening of nested objects (`a.b.c`); per key,
  per locale: `{ value, span }`. Non-string leaves (plural objects, arrays) keep a
  compact-JSON rendering as the value. A locale file that fails to parse surfaces in
  op results and demotes that file's claims to `partial` (the scss parse-failure
  precedent) — never silently dropped.
- **Cross-tier usages — ONE generic method on the `ts` plugin** (no i18n knowledge
  inside it): `literalCalls(fnNames: readonly string[])` →
  `{ fn, arg?: string, span, dynamic: boolean }[]` — scan for `CallExpression` whose
  callee matches a `fnName`; string-literal first arg → `arg`; template literal /
  computed → `dynamic: true`, never guessed (§18). The i18n plugin (`deps: ['ts']`)
  consumes it — the cross-tier fact lives with the plugin that observes it (§5).
  - **Import-resolved matching (Task F, spec-i18n-alias-aware):** the callee is matched
    against `fnNames` through its IMPORT via the checker, not only as written — a SIMPLE
    name (`t`) matches an identifier callee written `t` or a named-import alias
    (`import { t as tr }; tr(…)`); a DOTTED name (`i18n.t`) matches a member access whose
    base is `i18n` as written or through an aliased import (`import { i18n as i }; i.t(…)`).
    `fn` is the matched configured name, not the written callee. Matching is confined to
    USER-NAMED bindings: a bare `t` does NOT match an arbitrary `<import>.t()` and a
    destructure rename of a non-i18n value is not resolved — a match must be strong enough
    to ASSERT (find_missing/i18n_lookup report positive facts, so a name-collision match
    would fabricate, §3). The checker stays inside the `ts` plugin (the layering rule); the
    resolution is of the FUNCTION, never the key — a dynamic key is still `dynamic`.
    (Long-term close — true symbol-identity anchored on the i18n module — needs config to
    name the source; parked in docs/plan.md F-b.)
- **SymbolId:** `i18n:<dotted.key>@<locale-file>:v<n>` (§6 format). Rebind =
  re-locate the dotted key in the current parse; location-not-identity confidence
  rules apply (§6).
- **Plugin lifecycle:** `freshness()` fingerprints the locale file set
  (`common/fingerprint`, hash-on-tie); `reindex()` re-parses changed locale files;
  `pending()` surfaces. Same read-time backstop as everyone (§3.5/§8).
- **Ops** (each with table for sql, structured example, notes):
  - `i18n_lookup { key?, prefix? }` — per-locale values + proof spans + usage
    sites; keys missing in some locale listed per key. Columns:
    `key, locale, file, line, value`.
  - `find_unused_i18n_keys {}` — keys with zero literal usages. **Any** `dynamic`
    call of a configured function anywhere demotes every unused-claim to `partial`
    with a note (the `find_unused_scss_classes` precedent — a computed key could be
    any key). Columns: `key, file, line, confidence, note`.
  - `find_missing_i18n_keys {}` — literal usages whose key is absent in ≥1 locale,
    reported per locale; `dynamic` usages listed separately as unresolvable, never
    guessed. Columns: `key, locale, usage_file, usage_line, confidence`.

## 3. Tests (§16 — independent oracles)

| Claim                                                           | Oracle                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| keys + values match the files                                   | cold reparse in the test (`ts.parseJsonText` fresh) — same key→value map                                                |
| every key span is valid                                         | `assertSpansValid` against the raw locale JSON                                                                          |
| `t('a.b')` found; `t(\`x.${y}\`)`→`dynamic`, never guessed      | fixture                                                                                                                 |
| unused-claims demoted to `partial` when any dynamic call exists | fixture with one computed key                                                                                           |
| missing keys reported per locale                                | en/de fixture with a deliberate gap                                                                                     |
| parse-failure honesty                                           | malformed `de.json` → `partial`, file named, daemon up                                                                  |
| freshness honesty (mutate · add · checkout, watcher silenced)   | the §16 invariant-2 harness, run against the i18n plugin                                                                |
| cold == warm after locale edits                                 | §16 invariant 3 for the i18n plugin                                                                                     |
| plugin DAG                                                      | `i18n` declares `deps: ['ts']`; registry order respected (existing DAG test extended)                                   |
| ops registered unconditionally, gated only by plugin presence   | `builtinOps()` contains the i18n ops always; `status` on a fixture WITHOUT `config.i18n` hides them, WITH it shows them |

## 4. Non-goals

No ICU/plural semantics (values are opaque text). No write ops (add/rename key) —
Phase-2-style mutating work, separate spec. No symbol-resolved `t` aliasing v1 (the
stated syntactic limit). No locale file formats beyond JSON (YAML etc. — wishlist).
