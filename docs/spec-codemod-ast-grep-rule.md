# Spec: `codemod` — accept a full ast-grep rule (relational constraints)

Status: **proposed**. Extends the existing `codemod` op
([src/ops/codemod.ts](../src/ops/codemod.ts)). Additive and back-compatible: the current
`pattern` + `rewrite` string path is unchanged; this adds an optional `rule` object that
unlocks ast-grep's relational matching. Touches `ops/codemod.ts` only (the engine —
`@ast-grep/napi` — already supports it; we just stop hiding it). No plugin/daemon changes.

## 1. Problem & idea

`codemod` today exposes only a **single string `pattern`** to `root.findAll(pattern)`. ast-grep's
established rule syntax is far richer — **relational constraints** (`inside`, `has`, `follows`,
`precedes`), `not`, `all`/`any`, `regex`/`kind` refinements — and the engine codemaster already
depends on (`@ast-grep/napi`) accepts a rule object in the exact same `findAll` call. So the limit
is not the engine or a missing standard; it is that codemaster wraps a narrow slice of it.

The cost is real: a structural rewrite that must be **context-scoped** is impossible today.
"Rewrite `<Input/>` only when it is `inside` a `<Form>`", "replace `foo($A)` only when NOT already
`inside` a `try`", "change a prop only on a `<Button>` that `has` a `data-legacy` attribute" —
all need a relational rule. Without it the agent must over-match and hand-filter, or give up on
`codemod` and edit by hand (the exact friction `codemod` exists to remove).

This spec passes a **full ast-grep rule object** through. The rule is JSON (agents speak JSON args,
not YAML), structurally mirroring ast-grep's YAML rule.

## 2. Fixed decisions

- **One new arg: `rule?: JsonValue` (an object).** The matcher is **exactly one of** `pattern`
  (string, today) XOR `rule` (object, new) — zod `.refine` rejects both/neither with a pointed
  message. `rewrite: string` stays required and unchanged for both paths; `paths?`, `dirtyOk?`
  unchanged. The string-`pattern` path is byte-for-byte the current behavior (no regression).
- **The rule is passed straight to `root.findAll(rule)`** (napi accepts `string | object`). No
  re-implementation of ast-grep matching — the rule's semantics are ast-grep's, documented by
  ast-grep, not by us. Metavar captures still arrive via `match.getMatch` / `getMultipleMatches`,
  so the existing `substitute()` template expansion is unchanged.
- **Rewrite is OURS, not the rule's.** We do **not** read ast-grep's own `fix`/`transform` from the
  rule object — the replacement is always our `rewrite` template, expanded by us and gated by the
  §2.8 typecheck. (Reason: the typecheck gate + metavar guard are codemaster's honesty contract;
  delegating the edit to the rule's `fix` would bypass both. If a `fix` key appears in the rule it
  is ignored, with a note.)
- **Language unchanged.** Files are parsed Tsx/TypeScript per extension as today (§ current
  `rewriteFile`); the rule never carries a language. Tracked-TS-file selection + `paths` + the
  `..`-escape refusal + the `.tsx?/.mts/.cts` filter are all unchanged.
- **Mutating contract unchanged.** dry-run default, whole-program §2.8 gate (`crossFileScope`),
  introduced-vs-baseline diagnostics, byte-exact rollback — identical to the string path.

## 3. The guardrail that must extend (the load-bearing part)

`codemod` today statically scans the `pattern` string for metavariables and **refuses** a rewrite
that references a metavar the pattern never captured, or under the wrong `$`/`$$$` sigil
(`ops/codemod.ts` `metavars`/`hasTwoDollarMetavar`) — without it, an unbound `$X` emits literally,
can still compile, and is a **silent wrong edit**. This guard MUST cover the rule path:

- **Collect metavars from the whole rule tree, not one string.** A rule binds metavars in its
  top-level `pattern` AND in nested relational sub-patterns (`inside.pattern`, `has.pattern`,
  `follows`/`precedes`, inside `all`/`any` arrays). Walk the rule object, collect every `pattern`
  string's metavars (reusing `metavars()`), union them, and validate the rewrite against that union
  exactly as today. A rewrite metavar bound only by an `inside` sub-pattern is legal (ast-grep makes
  it available); one bound nowhere in the tree is refused.
- **`$$X` rejection** runs over the same collected strings.
- **Malformed rule → honest failure.** A rule ast-grep can't compile (bad key, bad kind) must return
  `ToolFailure{tool:'ast-grep'}` (wrap the `findAll`/parse call), never an exception to the agent,
  never a guessed edit (§3.6). zod validates only that `rule` is a non-empty object; ast-grep is the
  authority on rule validity (re-implementing its schema would be a second, drifting oracle).

## 4. Tests (§16 — independent oracles, inline-VFS)

| Claim                                                                | Oracle                                                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| relational scoping actually scopes                                   | fixture with two `foo(x)` calls, one `inside` a target context, one not; a `rule` with `inside` rewrites ONLY the in-context one; assert the other is byte-identical (the whole point) |
| a metavar bound by a relational sub-pattern is usable in the rewrite | `rule` whose `inside.pattern` captures `$C`; `rewrite` uses `$C`; assert it expands, not emitted literally                                                                             |
| unbound-metavar guard spans the rule tree                            | rewrite references `$Z` captured nowhere in the rule → `ToolFailure{codemod}` BEFORE any file is touched (`git status` clean)                                                          |
| both/neither matcher                                                 | `{pattern, rule}` together and `{}` (neither) each fail zod with a pointed message                                                                                                     |
| string-`pattern` path unchanged                                      | the existing codemod tests stay green verbatim (regression guard)                                                                                                                      |
| malformed rule                                                       | a bogus rule key → `ToolFailure{ast-grep}`, daemon up, nothing written                                                                                                                 |
| typecheck gate still applies                                         | a relational rewrite that introduces a type error is refused with `introduced` (reuses the baseline-diff gate)                                                                         |

## 5. Non-goals

- **ast-grep's own `fix`/`transform`/`rewriters`** — the edit stays our `rewrite` template (§2),
  so the typecheck gate and metavar guard always apply.
- **Multi-rule batch** — still one matcher per call (`rule` may be arbitrarily complex, but it is one
  rule). Several independent pattern→rewrite pairs in one call is a separate idea.
- **`utils` / cross-rule references / global rule registries** — a rule is self-contained per call.
- **Non-TS languages** — TS/TSX/mts/cts only, as today.
- **Type-aware (semantic) matching** — `codemod` stays shape-based by definition (§7); semantic
  edits remain the symbol-anchored ops' domain (rename/change_signature).
