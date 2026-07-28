// Shared honest hint for the symbol-addressed ops (find_usages / find_definition / search_symbol):
// when a NAME resolves to NOTHING and the repo has nested tsconfig(s) codemaster did not load as
// programs (`undiscoveredProgramLabels()`), the symbol may be declared under an unindexed program —
// so a flat "no symbol named 'X'" reads as "genuinely gone", the §3.4 completeness lie (the same gap
// `find_unused_exports`'s floor already names its unloaded configs for). This appends the NAMED
// unloaded configs, conservatively: never claims the symbol IS there — only that it COULD be,
// unindexed — and only on a GENUINE absence (an ambiguity / a positional miss / a found-but-no-refs
// is a resolution, not a miss, so it gets no hint).

import { nameWithMore } from '../common/truncate/name-with-more.ts';

const MAX_NAMED = 3;

/** True when `message` is a genuine "symbol not found" (the name-addressed absence). An ambiguity
 *  ("'X' is ambiguous"), a positional miss ("no symbol at the resolved position"), and a
 *  found-but-no-refs ("no references for any declaration of this name") all resolved the symbol —
 *  only a real ABSENCE can be explained by an unindexed nested program. */
export function isSymbolAbsence(message: string): boolean {
  return message.startsWith('no symbol named');
}

/** The undiscovered-program suffix to append to an absence message, or `''` when nothing is
 *  unloaded (the common single-repo — the caller's message stays byte-identical, so no false hint).
 *  Names up to `MAX_NAMED` configs, then `+N more`. */
export function undiscoveredHint(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  return ` — but ${labels.length} nested tsconfig(s) are NOT loaded as programs (${nameWithMore(labels, MAX_NAMED)}); the symbol may be declared ONLY under one of them (unindexed here). This is NOT proof it is gone — add the config to a parent \`references\` (or place it adjacent to the primary/main config) to index it.`;
}

/** Append the undiscovered-program hint to `message` when it is a genuine name-absence AND some
 *  program is unloaded. Any non-absence message (ambiguity / positional / merge-no-refs) or an empty
 *  `labels` returns `message` unchanged. */
export function withUndiscoveredHint(message: string, labels: readonly string[]): string {
  return isSymbolAbsence(message) ? message + undiscoveredHint(labels) : message;
}

/** §3.4/§3.6 FLOOR for a name-addressed `find_definition` that DID resolve (the sibling of the
 *  0-match `undiscoveredHint`, and of `usagesFloor`): when a NAME resolves to a decl but nested
 *  tsconfig(s) are unloaded, a DISTINCT same-named symbol may live under one — so a confident single
 *  definition is a possible MIS-target, not a proven answer. Returns the machine-readable verdict
 *  (`complete:false` + named `undiscoveredPrograms`) so a count-only consumer sees it WITHOUT prose,
 *  plus a `!!` note for the verdict position (§12). Empty when nothing is unloaded — the result stays
 *  byte-identical (no false hint). The resolved decls are each real; incompleteness is a property of
 *  the SET (another same-named decl may be unindexed), never a per-view demotion. */
export function definitionFloor(labels: readonly string[]): {
  fields: { complete: false; undiscoveredPrograms: readonly string[] } | Record<string, never>;
  note?: string;
} {
  if (labels.length === 0) return { fields: {} };
  return {
    fields: { complete: false, undiscoveredPrograms: labels },
    note: `!! LOWER BOUND — ${labels.length} repo tsconfig(s) NOT loaded as programs (${nameWithMore(labels, MAX_NAMED)}); a DISTINCT same-named symbol may be declared under one of them (unindexed here), so this definition may NOT be the one you want. This is NOT proof it is the only/right declaration — add the config to a parent \`references\` (or place it adjacent to the primary) to resolve across all programs.`,
  };
}

/** §3.4/§3.6 FLOOR for the OTHER cause of an incomplete name resolution: the LS's workspace-symbol
 *  search returned a full page, so it SLICED candidates before codemaster's exact-name filter ran
 *  (TS ranks by matchKind + name with no case tie-break — a flood of `span` can hide `Span`). A
 *  bare-name answer built on that page is therefore a floor: another declaration of the same name
 *  may sit behind the cut. Shaped exactly like `definitionFloor` (machine-readable verdict first,
 *  prose `!!` note for the verdict position) so a consumer reads one incompleteness vocabulary
 *  whatever the cause. `false` → empty, and the result stays byte-identical. */
export function searchCapFloor(truncated: boolean): {
  fields: { complete: false; searchTruncated: true } | Record<string, never>;
  note?: string;
} {
  if (!truncated) return { fields: {} };
  return {
    fields: { complete: false, searchTruncated: true },
    note: `!! LOWER BOUND — the workspace symbol search hit the LS's own result cap, so same-named declarations may exist BEHIND the cut and this answer covers only the ones it could see. NOT proof this is the only declaration; re-address with name+file / file:line:col, or enumerate with symbols_overview {duplicatesOnly:true}.`,
  };
}
