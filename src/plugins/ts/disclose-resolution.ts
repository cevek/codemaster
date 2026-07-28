// The ts plugin's one producer of envelope disclosures (§3.4/§3.6): a name→declaration resolution
// whose candidate set was cut cannot support "this is the only symbol of that name", so it states
// that claim once, at the resolve, for whatever op is answering.
//
// The claim, not the event. `searchTruncated` is computed from an EVENT (the LS's navto page came
// back full, cut inside the exact-name bucket) but is only ever emitted here as an ASSERTION about
// what the answer may not say. Ops read the assertion; nothing downstream re-derives it from the
// event, so producer and consumer cannot mean different things by the same bit.

import type { Disclosure } from '../../core/result.ts';
import { disclose } from '../../support/disclosure/ledger.ts';
import type { TsTargetInput } from './resolve-target.ts';

// Dense by contract (§12): the cause in one clause and the ONE canonical remedy. The full model —
// what the claim means, why it is a floor, how to enumerate the twins — lives once in the `status`
// concepts legend, not repeated per answer. The remedy is exact re-addressing because that is the
// one move guaranteed to resolve rank-independently; a `symbols_overview` sweep is a discovery aid
// with its own scope caveats (exported-only by default, collisions counted across FILES) and would
// be a second, weaker answer to the same question.
const NOTE =
  "the name→declaration page hit the LS's cap INSIDE the exact-name matches, so a distinct same-named declaration may sit behind the cut; counts / emptiness / completeness about this target are a FLOOR. Re-address exactly — name+file or file:line:col ranks nothing. (status → concepts:disclosure)";

/** How the target was addressed, so a disclosure is attributed to the resolution that is actually
 *  at risk. Only the two forms that can BE at risk are named: a bare name (ranked by navto) and a
 *  held handle whose §6 rebind fell back to the workspace search. */
function describe(target: TsTargetInput): string {
  // Same order the resolver dispatches in (`resolveTarget`): a call carrying BOTH a symbolId and a
  // name resolved through the HANDLE, so naming it as a bare-name resolution would attribute the
  // doubt to a field the resolver never read.
  if (target.symbolId !== undefined) return `handle ${target.symbolId}`;
  if (target.name !== undefined && target.file === undefined) return `name '${target.name}'`;
  // An exact form should never reach here (the resolver flags no truncation for one); describe it
  // honestly rather than mislabelling it as a name if it ever does.
  return target.name !== undefined ? `name '${target.name}'` : '<target>';
}

function sameNameClaim(target: string): Disclosure {
  return { unsafe: 'target-is-the-only-symbol-of-this-name', target, note: NOTE };
}

/** State the claim for a resolution the resolver marked truncated. Call sites pass the target they
 *  resolved, never a reconstructed one, so the attribution is the resolution's own. */
export function discloseTruncatedResolution(target: TsTargetInput): void {
  disclose(sameNameClaim(describe(target)));
}

/** The `mergeDeclarations` variant: the union is over the same-named declarations the candidate
 *  page held, which may be a SUBSET — the same claim, reached by either cap (the LS's page or our
 *  own view budget), since both leave same-named declarations unseen. */
export function discloseTruncatedMerge(name: string): void {
  disclose(sameNameClaim(`name '${name}'`));
}
