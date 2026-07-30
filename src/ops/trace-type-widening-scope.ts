// The ops-level honesty vocabulary for `trace_type_widening`'s cross-program REFERENCE fan — the
// counterpart of `scan-coverage.ts` for the type-anchored FILE scans, and deliberately not that
// module: its completeness discriminator is `walkedFiles === 0`, and this scan has no file
// denominator, so a value with no forward reference — an answer the fan fully established — would
// render `!! NOT A VERDICT` (§3.6, the same lie inverted). Its remedies would not survive the move
// either: `limit` / `pathInclude` are levers this op does not have, and naming a lever that cannot
// change the outcome is the t-259465 defect.
//
// One fact per note, each naming something the caller can actually do:
//   · a program SKIPPED    → the fan narrowed itself; its remedy is neither a budget nor a config
//   · per-step cap reached → the value has more forward references than one step checks
//   · undiscovered config  → the config was never loaded; loading it is the lever (`lowerBoundNote`)
//   · no-config fallback   → no real tsconfig covers the value / some of its references
//   · deadline expired     → the trace is unfinished; nothing about the levers above applies
//
// The scope is stated POSITIVELY and in its own unit (`12 forward reference(s), 12/12 checked`):
// a numerator with no denominator and no scope is read as proof of completeness (t-919920).

import type { JsonValue } from '../core/json.ts';
import type { WideningScanCoverage } from '../plugins/ts/plugin.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { lowerBoundNote } from './lower-bound-note.ts';

const MAX_NAMED = 3;

/** What a `trace_type_widening` floor is a floor OF, in the op's own nouns. */
const SUBJECT = {
  subject: 'flow-sinks',
  noun: 'flow-sink',
  negation: "that the value's precision is preserved everywhere",
} as const;

/** Only `complete` licenses reading `0 hops` as a claim about the VALUE ("it never flows onward").
 *
 *  There is no third `nothing-consulted` state here, and its absence is structural rather than an
 *  omission: a step whose fan consulted NO program returns a failure from the plugin (an honest
 *  "couldn't"), so an `ok` answer always rests on at least one consulted program. The empty-SCAN
 *  case is thus refused upstream instead of being explained downstream — which is the stronger
 *  form of the same guarantee (CONTRIBUTING: an `ok` shaped like a proven absence is worse than an
 *  incomplete answer). */
type WideningScanCompleteness = 'incomplete' | 'complete';

function wideningCompleteness(
  coverage: WideningScanCoverage,
  undiscovered: readonly string[],
): WideningScanCompleteness {
  return coverage.skipped !== undefined ||
    coverage.deadlineHit === true ||
    coverage.fallbackOnly === true ||
    coverage.fallbackExcluded === true ||
    coverage.examined < coverage.refs ||
    undiscovered.length > 0
    ? 'incomplete'
    : 'complete';
}

/** The machine-readable positive scope (§3.4): WHICH programs the trace consulted and how much of
 *  each, so a count-only consumer reads the scope without parsing prose. `complete` appears only
 *  when the trace fell short — a complete trace stays byte-identical apart from `programsScanned`. */
interface WideningScopeFields {
  complete?: false;
  programsScanned: string[];
  programsSkipped?: string[];
  undiscoveredPrograms?: string[];
}

function wideningScopeFields(
  coverage: WideningScanCoverage,
  undiscovered: readonly string[],
): WideningScopeFields {
  const complete = wideningCompleteness(coverage, undiscovered) === 'complete';
  return {
    ...(complete ? {} : { complete: false }),
    programsScanned: coverage.programs.map(
      (p) => `${p.label}: ${p.refs} forward reference(s), ${p.examined}/${p.refs} checked`,
    ),
    ...(coverage.skipped !== undefined
      ? { programsSkipped: coverage.skipped.map((e) => `${e.label} (NOT consulted: ${e.reason})`) }
      : {}),
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
  };
}

/** The scope line for the sql/table surface, which forwards `data.notes` verbatim but would
 *  otherwise show bare counters with no denominator — the exact defect this module closes on the
 *  text surface must not survive on a second one. */
export function wideningTableNotes(data: unknown): string[] {
  const scope = (data as { programsScanned?: unknown }).programsScanned;
  if (!Array.isArray(scope) || scope.length === 0) return [];
  return [`programs consulted: ${scope.map((s) => String(s)).join(' · ')}`];
}

/** Every floor note the coverage warrants, verdict-first (§12). Empty for a complete trace, so the
 *  common answer gains no prose. */
export function wideningFloorNotes(
  coverage: WideningScanCoverage,
  undiscovered: readonly string[],
): string[] {
  const notes: string[] = [];
  if (coverage.deadlineHit === true) {
    notes.push(
      `!! PARTIAL TRACE — the wall-clock budget expired after checking ${coverage.examined} of ${coverage.refs} forward reference(s); the rest were never analysed, so their ${SUBJECT.subject} are absent. The hops listed ARE real. Retry against a warm engine.`,
    );
  }
  if (coverage.examined < coverage.refs && coverage.deadlineHit !== true) {
    notes.push(
      `!! LOWER BOUND — per-step budget: ${coverage.examined} of ${floorMark(coverage)}${coverage.refs} forward reference(s) checked (limit ${coverage.limit} per step). These programs ARE loaded; the shortfall is the budget, NOT a missing config. Trace from a narrower value (an intermediate binding closer to the site you care about) to stay under it.`,
    );
  }
  if (undiscovered.length > 0) notes.push(lowerBoundNote(undiscovered, SUBJECT));
  for (const note of skippedNotes(coverage)) notes.push(note);
  if (coverage.fallbackExcluded === true) {
    notes.push(
      `!! LOWER BOUND — a whole-repo no-config fallback program containing this value was NOT consulted (a real tsconfig took over as its type authority): under DEFAULT compilerOptions (no \`paths\`/\`baseUrl\`) its verdicts are not the ones the project itself yields. References living ONLY in files no tsconfig covers were therefore not analysed. Add a tsconfig covering those files for a complete trace.`,
    );
  }
  if (coverage.fallbackOnly === true) {
    notes.push(
      `!! the repo has no tsconfig covering this value, so the trace ran on the whole-repo no-config fallback program under DEFAULT compilerOptions — alias imports do not resolve there and whole-repo type augmentations leak in, so each widening verdict is weaker than it looks. Add a tsconfig for a sound answer.`,
    );
  }
  return notes;
}

/** `≥` when the denominator is ITSELF a floor: an unconsulted program's references were never
 *  enumerated, so `refs` counts only what the fan reached (§12). */
function floorMark(coverage: WideningScanCoverage): string {
  return coverage.skipped !== undefined ? '≥' : '';
}

/** One note per SKIP REASON — grouped, because programs skipped for one reason share one remedy and
 *  repeating it per program would spend the reserved note budget restating a single fact. */
function skippedNotes(coverage: WideningScanCoverage): string[] {
  const skipped = coverage.skipped;
  if (skipped === undefined || skipped.length === 0) return [];
  const byReason = new Map<string, string[]>();
  for (const s of skipped) {
    const labels = byReason.get(s.reason) ?? [];
    labels.push(s.label);
    byReason.set(s.reason, labels);
  }
  const out: string[] = [];
  for (const [reason, labels] of byReason) {
    out.push(
      `!! LOWER BOUND — ${labels.length} program(s) in the fan were NOT consulted (${nameWithMore(labels, MAX_NAMED)}): ${SKIP_CAUSE[reason] ?? reason}. Any ${SUBJECT.noun} reachable only through their files is absent from this trace.`,
    );
  }
  return out;
}

/** Exhaustive over `SkippedWideningProgram['reason']` — cause AND remedy in one clause each, so a
 *  new reason cannot fall through to a plausible-but-wrong sentence (it renders its raw tag). */
const SKIP_CAUSE: Record<string, string> = {
  'no-value-here': `the position resolves to no value under that program's OWN compilerOptions, so it has no source type there to judge sinks against — neither a spent budget nor a missing config; re-run with that package as \`root\` to trace the value under those options`,
  deadline: `the wall-clock budget was already spent when the fan reached them, so their checkers were never warmed`,
  'program-unavailable': `the TS Language Service could not produce a Program (or this file) for them — an internal-tool failure, not a scope decision`,
};

/** The emptiness line for a 0-hop trace. A complete fan over a value that simply never flows onward
 *  HAS established that — printing a floor there would dress a complete answer as partial, the same
 *  lie inverted — so only an INCOMPLETE trace refuses the verdict. `undefined` when hops were found.
 *  (The third case, a fan that consulted nothing, never reaches an `ok` answer at all — see
 *  `WideningScanCompleteness`.) */
export function wideningEmptinessNote(
  coverage: WideningScanCoverage,
  undiscovered: readonly string[],
  hopCount: number,
): string | undefined {
  if (hopCount > 0) return undefined;
  const where = `${coverage.examined} forward reference(s) checked in ${coverage.programs.length} program(s)`;
  return wideningCompleteness(coverage, undiscovered) === 'complete'
    ? `no flow-sink among the ${where}: the value is never assigned, passed, returned or reassigned onward, so no precision is lost downstream of it.`
    : `no flow-sink among the ${where} — the trace is INCOMPLETE (see the floor note(s) below), so this is NOT proof ${SUBJECT.negation}.`;
}

/** The scope fields as a `JsonValue`-typed spread for the op's data object (verdict-first, §12). */
export function wideningScopeData(
  coverage: WideningScanCoverage,
  undiscovered: readonly string[],
): Record<string, JsonValue> {
  const fields = wideningScopeFields(coverage, undiscovered);
  return {
    ...(fields.complete === false ? { complete: false } : {}),
    programsScanned: fields.programsScanned,
    ...(fields.programsSkipped !== undefined ? { programsSkipped: fields.programsSkipped } : {}),
    ...(fields.undiscoveredPrograms !== undefined
      ? { undiscoveredPrograms: fields.undiscoveredPrograms }
      : {}),
  };
}
