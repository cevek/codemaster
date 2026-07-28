// The ts plugin's one producer of envelope disclosures (§3.4/§3.6): a name→declaration resolution
// whose candidate set was cut cannot support "this is the only symbol of that name", so it states
// that claim once, at the resolve, for whatever op is answering.
//
// The claim, not the event. `searchTruncated` is computed from an EVENT (the LS's navto page came
// back full, cut inside the exact-name bucket) but is only ever emitted here as an ASSERTION about
// what the answer may not say. Ops read the assertion; nothing downstream re-derives it from the
// event, so producer and consumer cannot mean different things by the same bit.

import type { Disclosure } from '../../core/result.ts';
import { disclose } from '../../common/disclosure/ledger.ts';
import type { TsTargetInput } from './resolve-target.ts';

const NOTE =
  "the workspace symbol search hit the LS's own result cap and the cut fell inside the exact-name matches, so a DISTINCT declaration of this name may sit behind it — the answer is about one of the declarations we could see, and any count / emptiness / completeness it states is a floor, not a fact. Re-address with name+file or file:line:col (an exact target ranks nothing), or enumerate the collisions with symbols_overview {duplicatesOnly:true}.";

/** How the target was addressed, so a disclosure is attributed to the resolution that is actually
 *  at risk. Only the two forms that can BE at risk are named: a bare name (ranked by navto) and a
 *  held handle whose §6 rebind fell back to the workspace search. */
function describe(target: TsTargetInput): string {
  if (target.name !== undefined && target.file === undefined) return `name '${target.name}'`;
  if (target.symbolId !== undefined) return `handle ${target.symbolId}`;
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
