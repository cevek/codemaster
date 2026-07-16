// The shared "undiscovered program → this count is a LOWER BOUND" §3.4 floor note. `find_usages`
// and `importers_of` emitted byte-for-byte the same note with only the noun swapped ("usages" vs
// "importers"); this is their single home (t-584829 stateless consolidation).
//
// NOT collapsed per session. t-584829 asked to shrink the repeated note to a one-line tag after its
// first appearance in a session — REJECTED: that needs cross-call session state, and a warm daemon's
// 2nd call would then differ from a cold-booted daemon's 1st call on the same repo state, violating
// the cold==warm honesty invariant (§16 invariant 3, CI-gated). The note is honest and per-call
// self-contained; the win here is de-duplication + tighter prose, not statefulness. Surfacing a real
// usage COUNT for the undiscovered programs (vs the warning) is a behavioral change (auto-load
// siblings) tracked separately.

import { nameWithMore } from '../common/truncate/name-with-more.ts';

const MAX_NAMED = 3;

/** The `!! LOWER BOUND …` note for a result whose count is incomplete because `labels` tsconfig(s)
 *  were not loaded as programs. `subject` is the plural counted thing ("usages" / "importers"),
 *  `noun` its singular ("usage" / "importer"), `negation` the false conclusion a low count would
 *  invite ("of deadness" / "that anything depends on it"). Keeps the machine-readable verdict fields
 *  (`complete:false` + `undiscoveredPrograms`) to its callers — this is only the prose channel. */
export function lowerBoundNote(
  labels: readonly string[],
  opts: { subject: string; noun: string; negation: string },
): string {
  const named = nameWithMore(labels, MAX_NAMED);
  return `!! LOWER BOUND — ${labels.length} repo tsconfig(s) NOT loaded as programs (${named}); ${opts.subject} under them were NOT counted — a low/zero ${opts.noun} count is NOT proof ${opts.negation}. Load/reference the config for a complete count.`;
}
