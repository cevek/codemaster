// The ts plugin's producer of envelope disclosures (§3.4/§3.6): a name→declaration resolution built
// on a candidate set we did not see whole cannot support "this is the only symbol of that name", so
// it states that claim once, at the resolve, for whatever op is answering.
//
// The claim, not the event. Several different events can make the claim unsafe — the LS's navto page
// cut inside the exact-name bucket, our own candidate budget cutting the merge set, a nested tsconfig
// never loaded as a program — and they are NOT interchangeable descriptions of each other. So the
// TYPE carries only the assertion, and the note names the cause(s) that actually applied on THIS
// call. Prose that names one cause while another fired is the same class of lie the assertion-vs-event
// split exists to prevent: the claim would be true and the explanation false, which is worse than
// silence because the agent acts on the explanation.

import type { Disclosure } from '../../core/result.ts';
import { disclose } from '../../support/disclosure/ledger.ts';
import { nameWithMore } from '../../common/truncate/name-with-more.ts';
import type { TsTargetInput } from './resolve-target.ts';

/** Why the candidate set could not be seen whole. Both may hold at once; each is stated only when it
 *  actually fired on this resolution. */
export type ResolutionDoubt = {
  /** The candidate set was cut before all same-named declarations were seen — by the LS's own page
   *  cap (sliced inside the exact-name matches) or by our candidate budget on the merge path. The
   *  two are one cause from the agent's side: declarations of this name exist that we never ranked. */
  cut: boolean;
  /** Nested tsconfig(s) codemaster did not load as programs. A DISTINCT same-named declaration may
   *  live under one, unindexed — so the resolved target may be the wrong one of several. */
  unindexed: readonly string[];
};

const MAX_NAMED = 3;

/** Dense by contract (§12): the cause(s) in one clause each and the ONE canonical remedy. The full
 *  model — what the claim means, why every count under it is a floor, how to enumerate the twins —
 *  lives once in the `status` concepts legend, not repeated per answer. */
function noteFor(doubt: ResolutionDoubt): string {
  const causes: string[] = [];
  if (doubt.cut) {
    causes.push(
      'the candidate set was cut before every same-named declaration was seen, so one may sit behind the cut',
    );
  }
  if (doubt.unindexed.length > 0) {
    causes.push(
      `${doubt.unindexed.length} nested tsconfig(s) are NOT loaded as programs (${nameWithMore(doubt.unindexed, MAX_NAMED)}), so a distinct same-named declaration may be declared there, unindexed`,
    );
  }
  return `${causes.join('; and ')}. Counts / emptiness / completeness about this target are a FLOOR. Re-address exactly — name+file or file:line:col ranks nothing. (status → concepts:disclosure)`;
}

/** How the target was addressed, so a disclosure is attributed to the resolution that is actually
 *  at risk. Branch order matches the resolver's own dispatch (`resolveTarget`): a call carrying BOTH
 *  a symbolId and a name resolved through the HANDLE, so naming it as a bare-name resolution would
 *  attribute the doubt to a field the resolver never read. */
function describe(target: TsTargetInput): string {
  if (target.symbolId !== undefined) return `handle ${target.symbolId}`;
  if (target.name !== undefined && target.file === undefined) return `name '${target.name}'`;
  // An exact form should never reach here (no doubt is computed for one); describe it honestly
  // rather than mislabelling it as a name if it ever does.
  return target.name !== undefined ? `name '${target.name}'` : '<target>';
}

function claim(target: string, doubt: ResolutionDoubt): Disclosure {
  return {
    unsafe: 'target-is-the-only-symbol-of-this-name',
    target,
    note: noteFor(doubt),
  };
}

/** State the claim for a resolution whose candidate set was incomplete. A no-op when neither cause
 *  fired — silence is the correct output for a resolution that supports what the answer says. */
export function discloseResolutionDoubt(target: TsTargetInput, doubt: ResolutionDoubt): void {
  if (!doubt.cut && doubt.unindexed.length === 0) return;
  disclose(claim(describe(target), doubt));
}

/** The `mergeDeclarations` variant, which resolves outside the shared chokepoint: the union covers
 *  the same-named declarations the candidate set held, which may be a SUBSET. */
export function discloseMergeDoubt(name: string, doubt: ResolutionDoubt): void {
  if (!doubt.cut && doubt.unindexed.length === 0) return;
  disclose(claim(`name '${name}'`, doubt));
}

/** What a completed resolution could not see. The unindexed cause is scoped to a BARE name: a
 *  handle, a position, and a `name+file` all pin the declaration, and a same-named twin under an
 *  unloaded program is irrelevant to an answer about a pinned one — claiming doubt there would dress
 *  a complete resolution as partial (§3.6). Structurally typed on the host so this stays a leaf. */
export function doubtOf(
  host: { undiscoveredProgramLabels(): readonly string[] },
  target: TsTargetInput,
  resolved: { searchTruncated?: true },
): ResolutionDoubt {
  const bareName =
    target.name !== undefined && target.file === undefined && target.symbolId === undefined;
  return {
    cut: resolved.searchTruncated === true,
    unindexed: bareName ? host.undiscoveredProgramLabels() : [],
  };
}
