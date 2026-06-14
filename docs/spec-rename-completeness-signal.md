# Spec: rename — surface the old name surviving via re-export aliases / `export *` (inbox KS-1)

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §3 (trust
contract — esp. §3.4 "no result that looks complete but isn't" and §3.6 "report capability, not just
data"), §6 (SymbolId / rebind), §7 (edit model); `docs/spec-refactor-port.md`; and CONTRIBUTING.md
before starting. Refines the inbox `[wish]` "rename: old name survives …" (2026-06-14, finding KS-1).
**Sequence after `spec-kitchensink-integration.md`** — its Stage 1 pins the repro in
`test/e2e/kitchensink-rename.test.ts` (FINDING KS-1); this spec reuses that test.

## 1. Problem (a missing signal, NOT a correctness bug)

`rename_symbol` over a deep re-export chain leaves the **old name alive** in two ways the TypeScript
LS does on purpose:

1. **Re-export aliasing** — to preserve a public name, the LS rewrites `export { formatLabel } from …`
   into `export { renderLabel as formatLabel }`. The old name `formatLabel` survives as a public alias.
2. **`export *` not traversed** — the LS's `findRenameLocations` does not walk `export *`, so a
   downstream named re-export reached only through `export *` (and its consumers) keep calling the old
   name.

The result **compiles clean** (the LS behavior is faithful and correct — `rename-sites.ts` is a pure
pass-through, verified). But the op reports `{mode:'applied', touched: N files, no partial, dropped: []}`
— which **reads as a COMPLETE rename**. It isn't: the old name survives as re-export aliases + live
consumer calls. That gap between "looks complete" and "is complete" is the §3.4 lie this contract
forbids — even though every individual edit is correct, the _summary_ over-claims.

This is a **wish**, not a correctness bug: do **not** change the rewrite (the LS behavior is right and
the edits compile). **Add an honest signal.**

## 2. Fixed decisions

- **Keep `rename-sites.ts` a faithful LS pass-through.** No change to what gets rewritten.
- **Compute the signal at the op level** (`ops/rename-symbol.ts`), from the post-rename state — the
  same place `dropped` / notes are surfaced. The op already has the result envelope; this adds a note
  to it.
- **Two survivor classes, reported distinctly and proof-carryingly (§3.2):**
  - **re-export aliases** the LS created (`export { <new> as <old> }`) — locatable: after rename, find
    the sites where the old name now appears as the alias half of a re-export.
  - **consumers reached only via `export *`** still using the old name — locatable: after the rename
    is staged, run a find_usages-style resolve of the **old** name; any site that still resolves to
    the (now-renamed) symbol through an `export *` chain is an un-updated survivor.
- **Surface like `dropped`:** a structured note, e.g. `oldNameSurvives: { reExportAliases: Span[],
exportStarConsumers: Span[] }`, each with `file:line` proof, plus a one-line human summary ("old
  name `formatLabel` survives as 2 re-export alias(es) and 1 consumer reached via `export *` — not
  updated"). Absent (or empty) when the rename is genuinely complete (no false positive on a simple
  rename with no re-export chain).
- **Never block / never auto-fix.** The op still reports `applied` (the edits are correct); the note
  is an honest disclosure the agent acts on, not a refusal.

## 3. Stages

**Definition of done** (§17 + CONTRIBUTING): `fix-and-check` green · the KS-1 repro test asserts the
note is present and names the survivors · a clean rename (no re-export chain) carries NO note (no false
positive) · proof spans valid (§16 inv.1) · no change to the rewrite set (faithful LS) · docs at
present state.

### Stage 1 — detect + surface

- **Build.** In `ops/rename-symbol.ts` (or a small helper beside it), after the LS rename plan is
  computed: (a) scan the touched files for `export { <new> as <old> }` re-export aliases the rename
  introduced; (b) resolve the **old** name post-rename and collect any site still bound to the renamed
  symbol via an `export *` chain (the LS-untraversed consumers). Attach `oldNameSurvives` (the two
  Span lists + summary) to the §2.10 envelope as a note when non-empty.
- **Reuse.** The ts plugin's existing reference/resolution APIs (`findUsages` / `importersOf` /
  `referenceSpans`) and the SymbolId/span machinery — do not stand up a new resolver.
- **Oracle.** Extend `test/e2e/kitchensink-rename.test.ts` (KS-1): renaming `formatLabel`→`renderLabel`
  over the M4 chain asserts the note names the 2 re-export aliases (`chain/c.ts`, `shared/index.ts`)
  and the `export *`-reached consumer (`chain/a.ts` / `Dashboard.tsx`), with valid spans; a control
  rename of a symbol with no re-export chain carries no note.
- **Exit.** The rename envelope honestly discloses surviving old-name sites; KS-1 flips from a
  quarantined/wish finding to an asserted behavior; no false positive on simple renames.

## 4. Review protocol

- **bug-reviewer** — the rewrite set is unchanged (faithful LS); the survivor detection has no false
  positives (a complete rename → empty note) and no false negatives on the KS-1 chain; spans valid.
- **doc-sync-reviewer** — `findings-kitchensink.md` KS-1 marked resolved; the inbox item closed;
  spec-refactor-port §6 (if it lists this as a known limitation) updated to present state.

## 5. Note on scope

This addresses the rename completeness _signal_ only. The broader "should rename optionally chase
`export *` consumers and update them" is a deliberate non-goal here — the LS's non-traversal is
faithful, and rewriting through `export *` is a separate, riskier feature. Honest disclosure first.
