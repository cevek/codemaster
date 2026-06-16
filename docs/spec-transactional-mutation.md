# Task E — Transactional multi-mutation (chain of edits, one gate, all-or-nothing)

> Self-contained task. Build on `main`. **DEPENDS ON Task A** (capture-safety + the mutation-envelope
> changes) — run AFTER A lands. First: read `CLAUDE.md`, `ARCHITECTURE.md` §7 + §2.8 + §3, call
> `status`, READ `src/ops/refactor-apply.ts` + `src/ops/refactor-plan-apply.ts` (the dry-run/apply/
> gate/rollback core) — this task composes them.

## Why

A real refactor is almost always a CHAIN (rename → move → change_signature → …). Today each mutating
op is isolated: each writes + typechecks + can leave the tree mid-sequence if a later step fails. The
review asks for a transactional sequence: apply N mutations with ONE typecheck gate at the end and
**all-or-nothing** rollback.

## Scope — IN

- A way to submit an ORDERED sequence of mutating ops and apply them atomically: each step's edits
  feed the next (the i+1-th op plans against the i-th's post-edit overlay/state), ONE §2.8 gate over
  the cumulative result, and **byte-exact rollback of the WHOLE sequence** if any step fails to plan,
  the final gate is unclean, OR `captures` (Task A) is non-empty anywhere. Dry-run previews the
  cumulative diff + final verdict without writing.
- Honest partial reporting: if step k can't even be planned, say which step and why; never apply a
  prefix. Dirty-gate the union of touched files once.
- Decide the surface: likely a new op `transaction { steps: [{name,args}, …] }` (NOT `batch` — batch
  is read-oriented, results-in-order; this is a single atomic write). Keep the 3-tool MCP shape (§11)
  — it's another `op`, not a 4th tool.

## Scope — OUT

- New mutation KINDS (use existing rename/move/extract/change_signature/codemod/move_symbol as steps).
- scale.

## Definition of done

- `fix-and-check` GREEN; full suite 0 fail.
- Oracle-backed edit-safety tests (§16.4): a 3-step chain (e.g. rename→move→change_sig) applies with
  ONE final clean typecheck and the cold `ts.Program` compiles; a chain whose LAST step introduces an
  error rolls back the WHOLE sequence byte-exact (`git diff` empty); a chain where a middle step can't
  plan refuses with the step index and writes nothing; a chain that would CAPTURE (Task A) refuses.
  `diff(dry)==diff(apply)` for the cumulative diff.
- Ethos: never a half-applied tree (the worst failure mode here); wrapped/bounded; honest per-step
  reporting; layering; files ≤300. Self-describe in `status`. Dogfood live through the MCP.

## Files

`src/ops/transaction.ts` (new) · `src/ops/refactor-apply.ts` / `refactor-plan-apply.ts` (factor out a
reusable "plan against current overlay" + "gate once" seam — **OVERLAP with Task A**; that's why this
runs after A) · `src/ops/builtins.ts` · `src/mcp/schema.ts` · status catalogue · tests.

## Dependency / parallel note

**Sequenced after Task A** (shares + extends the mutation-envelope/gate core; needs `captures`). Do
NOT run truly parallel with A. Own branch off the post-A `main`.
