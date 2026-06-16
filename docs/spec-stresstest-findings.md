# Spec: stress-test findings — mutation-gate, codemod, output & honesty hardening

Status: **implemented** (§1–§6, with one recorded carve-out: §1b is fixed for `move_file`; the
`extract_symbol` half is a documented known limitation — see §1b). §7 wishes still parked; the
daemon-singleton (§6 root) is its own spec. Consolidated backlog from a 90-point adversarial stress
test of the MCP
surface against `amiro` — full evidence in [findings-stresstest.md](findings-stresstest.md)
(report) + [findings-stresstest-journal.md](findings-stresstest-journal.md) (per-point journal);
9 in-band `feedback` entries triaged here. The **read/search/type/scss/i18n/sql layer passed
clean** — every ground-truth check matched, no read-path lie found. All actionable findings sit in the
**mutating ops + codemod + output/honesty edges** below. The 100%-of-calls
`daemon code behind source` banner is the symptom of the unimplemented daemon singleton —
tracked in [spec-daemon-singleton.md](spec-daemon-singleton.md) (§6 here adds only the
banner-UX note). Evidence is cited by `Pxx` (journal point) and reproduced on current code where
noted.

## 1. Typecheck-gate trustworthiness (HEADLINE — the gate is built on sand)

The mutating-op §2.8 gate diffs post-edit diagnostics against a pre-edit baseline (the
`buildTypecheckField` baseline-diff). The stress test showed the baseline itself is wrong, which
poisons every verdict.

- **1a (P0, ROOT) — the LS reports ~600 phantom errors the project's own tsc does not.** On a
  byte-clean `amiro`, every mutation reports `preExisting≈602` while the project's `tsgo`/`tsc` =
  **0** (P53/P57 confirmed independently; reproduced here: a no-op codemod → `preExisting=602`).
  **ROOT CAUSE (empirically narrowed — the original tsconfig hypothesis was DISPROVEN):** the
  config loads correctly (`moduleResolution=Bundler`, `paths`, `allowImportingTsExtensions` all
  present), and it's not a TS-version issue. The bug is a missing **`realpath`** on the
  `LanguageServiceHost`. `tsc`/`createProgram` canonicalize symlinks (`realpath: sys.realpath`);
  the LS host omitted it, so on a **pnpm** repo (whose `node_modules/<pkg>` are symlinks into
  `.pnpm/`) the same package loads under TWO paths — the symlink for a direct dep, the realpath for
  a transitive one — and its types stop unifying: `UseSuspenseQueryOptions` ≠
  `UseSuspenseQueryOptions`, callbacks lose their parameter types (implicit-any), valid object
  literals are rejected → ~600 phantom errors. Proof: a cold `createProgram` over the SAME files +
  options = **0**; the LS-built program = **602**; adding `realpath` to the host = **0**. **This
  violated ARCHITECTURE §5/§19** ("a different tsc means different diagnostics, a lie"). **Fixed:**
  the LS host now sets `realpath: tsm.sys.realpath` (guarded for synthetic overlay paths). Baseline
  is ≈0 again — with a correct baseline the diff is trustworthy and 1b/1c follow.

- **1b (P1, move/extract re-key) — a moved file's OWN pre-existing errors are re-counted as
  `introduced`.** `buildTypecheckField` keys diagnostics by `file·line·message`; `move_file` /
  `extract_symbol` change a file's path, so its pre-existing errors leave the baseline (old path)
  and re-appear as `introduced` (new path) → a semantically-safe move is REFUSED. Proof (P58,
  reproduced here moving `query-client.ts`): `602 = 596 + 6` — `preExisting` dropped exactly by
  the count that surfaced as `introduced`, same errors, new path. **This is a flaw in the
  baseline-diff shipped this session.** **Fixed for `move_file`:** the op now threads `plan.moves`
  (old→new path mapping, exact for a file move + prefix for a folder move) into
  `buildTypecheckField`, which re-keys the moved file's baseline diagnostics before the
  introduced-delta — verified op-level (move a file carrying a real pre-existing error → not
  refused, error rides as `preExisting`). **Known limitation — `extract_symbol` not fixed:** extract
  relocates a SUBSET of a file (new path AND shifted line), so the `file·line·message` key breaks
  beyond a path-remap; a pre-existing error inside an extracted block still over-refuses the extract
  (erring toward refuse on a changed file is the safe write-gate direction). A span-aware remap is
  the follow-up; extract of clean code (the common case) is unaffected.

- **1c (P69) — the gate is NON-DETERMINISTIC: identical op, dry-run `clean=false` vs apply
  `clean=true`.** The same codemod produced `introduced(3), preExisting=599` on dry-run and
  `clean=true, preExisting=602` on apply — the phantom-error set fluctuates across whole-program
  builds (599 vs 602), so a safe edit is refused on an unlucky pass and allowed on a lucky one.
  Root is 1a (unstable phantom errors) + checker incremental-state/order dependence. Fix: pin a
  deterministic `Program` snapshot for the before/after pair; subsumed by 1a once phantoms are gone.

> Note: the baseline-diff (introduced-vs-preExisting) is correct in design and works for in-place
> edits on a clean baseline — but it cannot rescue a baseline that is wrong (1a) or unstable (1c),
> and it has the path-rekey bug (1b). Fix 1a first; then 1b; 1c should fall out.

## 2. codemod correctness

- **2a (P70) — `$$$` many-node metavar emits malformed output.** `cn($$$A)` → `clsx($$$A)` on
  `cn(badgeVariants({variant}), className)` produced `clsx(badgeVariants({variant}), ,, className)`
  — spurious empty commas, invalid syntax. The multi-match substitution double-emits the separator
  commas. The gate/prettier catch it (nothing written), but `$$$` is broken on the exact case the
  docs advertise. Fix: the `substitute()` join for `getMultipleMatches` must not re-emit the
  source separators.

- **2b (P71) — `codemod.paths` silently matches nothing for directory globs.** `paths` of
  `['src/features/sales/**']` and `['**/*.ts']` → 0 matches, `clean=true`, no warning; only a
  literal file path worked. `codemod.paths` is treated as literal paths, while `pathInclude`
  (scss/usages) accepts globs via `matchesAnyGlob`. A silent 0-match reads as "no matches in
  scope" — dangerous. Fix: run `paths` through the same glob engine, OR fail loudly when a `paths`
  entry resolves to zero files.

## 3. Output / API

- **3a (P52) — a large mutation diff hits OUTPUT CAPPED and hides the typecheck/touched summary
  below it.** rename of `formatCurrency` (~24 files) printed the unified diff, capped at ~50k, and
  the `typecheck: clean=… introduced(…)` + `touched` summary (emitted AFTER the diff) fell past
  the cap — so on big edits the user never sees whether the edit is safe. Mutating ops have no
  `sql` to slim output. Fix: print the verdict summary (typecheck + touched count) BEFORE the
  diff, and/or add a `summaryOnly`/terse mutation mode.

- **3b (P28) — the documented `fields:[…]` projection dial is uninvokable.** `status` concepts +
  per-op `columns` advertise it, but it's rejected both top-level (zod `expected array, received
string`) and in `args` (`Unrecognized key: fields`). Workaround that works: `sql:"SELECT … FROM
t"`. Fix: wire `fields` into the op flag schema, OR drop it from the docs and point to sql
  projection (don't advertise an uninvokable dial).

## 4. Honesty-contract edges (from the journal)

- **4a (P64) — `extract_symbol` of a NESTED symbol silently retargets to the enclosing top-level.**
  Extracting a nested `BoundInput` / `wrappedOnSubmit` silently extracted the enclosing `useAppForm`
  (a 98k diff) instead of refusing. §6 "never silently retarget" — the op should refuse with a
  ts-ls category (or state the retarget on the envelope), not quietly act on a different symbol.

- **4b (P76) — a cross-root SymbolId name-rebinds onto a DIFFERENT repo's same-named symbol.** An
  `amiro` SymbolId passed with `root:'../customer-frontend-v2'` was `rebound` (confidence=partial,
  "structural continuity not proven") onto cf2's own `formatCurrency` — a different symbol. The
  status concept says "SymbolIds do not cross roots (re-search in the new root)". Honest about the
  uncertainty, but a cross-repo name-rebind is conceptually wrong. **Fixed:** every `ts:` SymbolId
  now carries a `~<rootTag>` origin stamp (an 8-hex FNV of the canonical root the orchestrator
  already dedups engines by); `resolveSymbolId` refuses to name-rebind a handle whose tag ≠ the
  resolving host's tag, returning `gone` + "re-search in this root" instead. Same-root handles still
  resolve/rebind across calls and respawns (the tag is stable per root). Scope: `ts:` ids only —
  `scss:`/`i18n:` handles are not yet origin-gated (out of this fix's scope; they share the
  re-search guidance).

- **4c (P1) — root resolution warms ANY folder, even a non-TS one, and is silent on a bad relative
  root.** A Java repo (`control-plane`, 0 `.ts`, 0 tsconfig) was taken as a warm root (indexing a
  vendored `.github/.../dist/index.js`); and an unresolvable relative `root` gave a silent
  `workspace: none resolved`. Fix: validate a root is a TS project (tsconfig / ≥1 tracked `.ts[x]`)
  before warming, and surface "no TS project at <path>" instead of a silent none.

## 5. Minor / docs

- **5a (P5)** — fuzzy `search_symbol` is weaker than the "editor Cmd+T style" doc claim: a valid
  subsequence `frmtCurncy` → `formatCurrency` returned 0 (honest empty, not a lie). Improve the
  matcher or soften the doc.
- **5b (P10/P25)** — an ambiguous decl prints two entries at the same `file:line` with no column
  (`NumberInput` = `const` + named-fn-expr both `:41`), reading as a spurious dup. Add the column.
- **5c (P17)** — `find_usages role:read|write` is syntactic (identifier-level), not zustand
  store-FIELD access (a hook call is all `call`). Honest, but the op note should say it doesn't
  resolve store-field reads/writes.

## 6. Cross-ref: the `daemon code behind source` banner

100% of calls were prefixed with the un-actionable `reconnect MCP` banner (an MCP client can't
reconnect mid-session). Root = the unimplemented singleton → [spec-daemon-singleton.md](spec-daemon-singleton.md).
**Addition here:** even with the singleton, make the staleness banner a **one-shot per session**
(first response only), not per-call — repeating an un-actionable warning on every call is noise
that erodes trust.

## 7. Deferred new-op wishes (out of fix-scope; from the inbox)

Not fixes — parked here so they're tracked (candidates for `docs/wishlist.md`):

- **`construction_sites`** — given a type `T`, every object literal the checker considers
  assignable to it (factory returns, array elements, var inits, fixtures), proof-carrying. The
  type-aware answer to "I added a required field — which construction sites break?" (grep can't).
- **`css_cascade`** — resolved cascade/specificity analyzer: for a CSS-module class/element, every
  rule targeting it across sheets ordered by specificity + the winner per property (catches a
  descendant/attribute selector silently beating a local class across module boundaries). Extends
  the syntactic scss plugin with a resolved view; `partial` where attrs/state are dynamic.

## 8. Priority

- **P0:** §1a (LS loads project tsconfig) — unblocks the entire mutation gate; until then every
  `clean`/`introduced` verdict on a real repo is suspect.
- **P1:** §1b (move/extract path re-key — shipped bug), §2a/2b (codemod), §4a (extract silent
  retarget).
- **P2:** §3a (summary-before-diff), §3b (fields), §4b/4c (cross-root rebind, root validation), §6
  (one-shot banner).
- **P3:** §5 (fuzzy / column / role doc), §7 (new-op wishes), §1c (should resolve via §1a).

## 9. Non-goals

- Re-litigating the read/sql layer — it passed; no changes proposed there.
- Implementing the daemon singleton (its own spec).
- The two new ops in §7 (wishes, not this spec's fixes).
