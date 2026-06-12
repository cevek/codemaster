# Spec: textual-occurrence overlay on `find_usages` (`text: true`)

Status: **approved**. Second in this round's order:
[spec-cross-repo-root.md](spec-cross-repo-root.md) → **this** →
[spec-i18n-plugin.md](spec-i18n-plugin.md).

## 1. Problem & the boundary we keep

Field case: deleting a symbol. Semantic refs alone miss JSDoc mentions, comments,
strings, markdown — so agents kept a second mental model and re-ran grep. Generic
text search stays **not** a codemaster op (the agent has ripgrep; we add no value
echoing it). The value we _can_ add is the **join**: semantic refs ∪ textual
occurrences, **deduped against each other**, with the textual half explicitly
unproven. The agent can't do that dedup cheaply; we can.

## 2. Fixed decisions

- **Flag `text?: boolean` (default false) on `find_usages`** — works for the single
  target and the `symbols` form. The pattern is the resolved symbol's **name**,
  word-boundary, case-sensitive. No regex input (that's ripgrep's job).
- **`support/text-search/`** — seam + pure-JS scanner v1 (no system-binary
  dependency; ripgrep impl can drop in behind the seam if profiling asks). Scans the
  tracked-file listing (`support/git` ls-files; walker fallback) including `.md` /
  `.json` / `.scss`; skips binaries and >1 MB files (the §10 default ignore set).
  All fs reads wrapped (§3.6).
- **Anti-join:** a text hit whose range overlaps any semantic ref span (or the
  definition/`decl` span) is _covered_ and dropped. The remainder returns as a
  separate section:
  `textOnly: [{ span, confidence: 'unresolved' }]` + `textTotal`, capped (default 50) with explicit truncation. Render header says the contract out loud:
  `text-only (same text — identity NOT proven):`. A same-named unrelated binding
  landing here is the feature, not a bug: the LS never claimed it, and neither do we.
- **Failure isolation:** if the text scan fails, the semantic half still returns —
  `partial` with the failure named, never a whole-call FAIL.
- **sql table:** new column `provenance: 'semantic' | 'text'`. Text rows appear
  **only when `text:true`** (existing queries can't change meaning under their
  feet); their `role`/`encloser*` columns are NULL — role is an AST concept, NULL
  means "not our domain", `0`/`''` would be a measured claim.
- **Interplay:** import collapse and role filters apply to the semantic section
  only; `text:true` + `role:…` is valid (semantic side filtered, text side
  unaffected — it has no roles).
- **ARCHITECTURE.md update (present-state rewrite, §16 + the §5 op-table row):**
  generic text search is not an op; `find_usages text:true` is a
  semantic∪textual join whose textual half is flagged `unresolved` — state it as if
  it had always been so.
- Op `notes` (status is the doc): one clause — "deleting a symbol? `text:true` adds
  comment/string/doc occurrences, deduped, identity unproven".

## 3. Tests (§16 — independent oracles)

| Claim                                                                                                                  | Oracle                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| completeness: every word-boundary occurrence of the name is either covered by a semantic span or present in `textOnly` | an independent naive scanner written in the test (line-split + `\b` regex — different algorithm than the impl); plus one ripgrep cross-check test, skipped when `rg` is absent |
| dedup: `textOnly` ∩ semantic spans = ∅                                                                                 | span-overlap assertion on a fixture where the same line holds both                                                                                                             |
| JSDoc/comment/string/markdown hits land in `textOnly`, `unresolved`                                                    | fixture                                                                                                                                                                        |
| aliased-import usage does NOT appear in `textOnly` (it is semantic)                                                    | the §16 aliased-JSX fixture extended                                                                                                                                           |
| same-named unrelated symbol → `textOnly`, never the semantic section                                                   | two-scope fixture                                                                                                                                                              |
| scan failure → semantic result + `partial`, daemon up                                                                  | unreadable-file seam                                                                                                                                                           |
| sql: text rows only under `text:true`; `provenance` correct; NULL role                                                 | table assertions                                                                                                                                                               |
| proof spans valid for text hits                                                                                        | `assertSpansValid` against the raw files                                                                                                                                       |

## 4. Non-goals

No regex/arbitrary-pattern search. No fuzzy matching. No scanning untracked /
gitignored files. No replacing ripgrep — the op `notes` keep steering literal-text
exploration to the agent's own grep.
