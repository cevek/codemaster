// t-411303 — the addressing predicate the CONDITIONAL fan-out guards share (find_definition,
// trace_prop_through_tree, trace_type_widening). A target FANS the LS across every program only when
// it resolves via `searchSymbols` (the all-program navto fan, the original t-167395 OOM): a bare
// `name` (`resolveByName`), OR a `symbolId` whose recorded position may no longer match → the §6
// REBIND branch (`resolveSymbolId`→`searchSymbols`). A `name+file` / `file+line[:col]` target is
// single-program-exact and never fans, so guarding it would be a false refusal (a regression, §1).
//
// The rebind fan is conditional (a fresh handle resolves cheaply), but the op can't see that
// pre-resolve, so `symbolId` is treated as fan-capable — a false refusal there redirects honestly to
// process-mode, consistent with the unconditional fanout ops.

/** True when the target may resolve via a repo-wide navto fan (bare `name` or any `symbolId`). A
 *  target pinned to a file (`name+file` / `file+line[:col]`) is single-program-exact → false. */
export function isFanCapableTarget(args: {
  symbolId?: string | undefined;
  name?: string | undefined;
  file?: string | undefined;
}): boolean {
  return args.symbolId !== undefined || (args.name !== undefined && args.file === undefined);
}
