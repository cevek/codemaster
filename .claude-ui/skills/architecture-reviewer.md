## codemaster — the contract you enforce

Read before judging: `ARCHITECTURE.md` §3 trust contract, §4 parsing
model, §5 layers, and the `src/README.md` import table — check every new import against that table.
What a generic architecture pass misses here:

1. **Module placement.** A type fact does not leak out of `plugins/ts`; a framework concept does not
   leak out of its plugin; an op does not reach into a plugin's internals; pure logic is NOT in
   `support/` (external-tool wrappers), external I/O is NOT in `common/` (pure only, `Clock` seam for
   time); a `utils.ts` / `helpers.ts` / `misc.ts` in `common/` / `support/` is banned.
2. **One parser per domain (§4).** `plugins/ts` is the only TS parser (the LS); no tree-sitter, no
   ts-morph, no second TS parser that could disagree with the first. The one bounded exception is the
   LS-relocation rescue fork: an edit producer, not a fact oracle.
3. **A cached answer inside a plugin** is legal only with an invalidation authority named in §3.1;
   freshness is checked on read, never taken from the watcher (§3.5).
4. **A change that changes a decision** updates `ARCHITECTURE.md` to the present state.
