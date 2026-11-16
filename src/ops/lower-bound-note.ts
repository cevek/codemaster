// The shared "undiscovered program → this count is a LOWER BOUND" §3.4 floor note: every op whose
// count can be floored by an unloaded tsconfig states it in these words, only the nouns differ.
//
// Each answer is self-contained — the `Result` carries the whole note, so a cold daemon and a warm one
// answer identically (§16 inv. 3). The explanation after the `!!` facts is a lesson per noun variant:
// the MCP facade folds its repeats within one session (§12), the facts never fold. A caller with a
// noun set not in `FLOOR_NOUNS` still gets the full note — it just never folds.

import { defineLesson, type Lesson } from '../common/lesson/lesson.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';

const MAX_NAMED = 3;

export interface FloorNouns {
  /** The plural counted thing ("usages"). */
  subject: string;
  /** Its singular ("usage"). */
  noun: string;
  /** The false conclusion a low count would invite ("of deadness"). */
  negation: string;
}

/** The one home of each op's floor nouns: the callers pass these, and the lessons are built from
 *  the same objects, so a reworded noun can never silently stop folding. */
export const FLOOR_NOUNS = {
  usages: { subject: 'usages', noun: 'usage', negation: 'of deadness' },
  importers: { subject: 'importers', noun: 'importer', negation: 'that nothing depends on it' },
  construction: {
    subject: 'construction sites',
    noun: 'construction site',
    negation: 'that nothing builds it',
  },
  discrimination: {
    subject: 'discriminating switch/if-chains',
    noun: 'discriminating switch/if-chain',
    negation: 'that nothing switches on it',
  },
  widening: {
    subject: 'flow-sinks',
    noun: 'flow-sink',
    negation: "that the value's precision is preserved everywhere",
  },
} as const satisfies Record<string, FloorNouns>;

function explanation(n: FloorNouns): string {
  return `${n.subject} under them were NOT counted — a low/zero ${n.noun} count is NOT proof ${n.negation}. Load/reference the config for a complete count.`;
}

export const LOWER_BOUND_LESSONS: readonly Lesson[] = Object.values(FLOOR_NOUNS).map((n) =>
  defineLesson({
    id: `lower-bound-${n.noun.split(/[ /]/)[0] ?? n.noun}`,
    full: explanation(n),
    short: `${n.subject} under them NOT counted — a FLOOR`,
  }),
);

/** The `!! LOWER BOUND …` note for a result whose count is incomplete because `labels` tsconfig(s)
 *  were not loaded as programs. Keeps the machine-readable verdict fields (`complete:false` +
 *  `undiscoveredPrograms`) to its callers — this is only the prose channel. */
export function lowerBoundNote(labels: readonly string[], nouns: FloorNouns): string {
  const named = nameWithMore(labels, MAX_NAMED);
  return `!! LOWER BOUND — ${labels.length} repo tsconfig(s) NOT loaded as programs (${named}); ${explanation(nouns)}`;
}
