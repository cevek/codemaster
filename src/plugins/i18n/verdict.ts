// The ANSWER-LEVEL verdict of an unused-keys scan (t-949045): given the demotion decision, the
// causes in effect and the rows this call REPORTS, decide what the answer may claim about itself.
// Split from plugin.ts (300-line cap) and pure, so the honesty rule it encodes is unit-testable
// without a project.
//
// The rule: a dynamic call degrades THIS answer only when it demoted a REPORTED key — a scoped
// question (`prefix=ui`) whose every row is provable must not be stamped `degraded` by a call
// confined to `errors.codes.*`. The other two causes stay WHOLE-SCAN, because they HIDE keys
// rather than demote them: an unreadable locale (a dead key could live only there) or an
// unresolved module (no usage matched at all) makes even an EMPTY list incomplete, and reporting
// that as clean is the §3.6 completeness lie this scoping must not open.
//
// Per-key confidence is NOT decided here — it is the whole-scan fact `isKeyDemoted` owns, so
// nothing in this file can turn a live key into a `certain` dead one.

import { nameWithMore } from '../../common/truncate/name-with-more.ts';
import { isKeyDemoted, type DynamicDemotion } from './demotion.ts';
import type { UnusedKeyView } from './views.ts';

/** How many demoted namespaces the reason names before it says `+N more`. The string renders
 *  AHEAD of the rows (§12 verdict-before-bulk), and a repo with many `t(`ns.${x}`)` calls has as
 *  many heads — the full set stays on `demotedPrefixes` for a consumer that wants it. */
const REASON_NS_CAP = 3;

export type UnusedVerdict = {
  degraded: boolean;
  degradedReason?: string;
  nonCallCause: boolean;
  anyProvableKey: boolean;
};

export function unusedVerdict(input: {
  /** The rows this call reports — the scope the summary verdict answers for. */
  unused: readonly UnusedKeyView[];
  /** Every key in the repo (unscoped) — the whole-scan basis of `anyProvableKey`. */
  allKeys: Iterable<string>;
  demotion: DynamicDemotion;
  demotedPrefixes: readonly string[];
  globalDemote: boolean;
  hasFailures: boolean;
  unresolved: boolean;
}): UnusedVerdict {
  const { unused, demotion, demotedPrefixes, globalDemote, hasFailures, unresolved } = input;

  // Causes no call can fix: they hide keys/usages, so they degrade the answer whatever its rows.
  const hiddenCauses: string[] = [];
  if (hasFailures) hiddenCauses.push('a locale file failed to parse');
  if (unresolved)
    hiddenCauses.push('the configured i18n module did not resolve — no usage could be matched');

  const anyPartial = unused.some((u) => u.confidence === 'partial');
  const degraded = anyPartial || hiddenCauses.length > 0;

  // ONE reason string — never stamped per row (identical for every demoted key). The namespace
  // form names only the heads that actually cover a REPORTED key.
  const reached = demotedPrefixes.filter((p) => unused.some((u) => u.key.startsWith(p)));
  const unprovableCauses = [
    ...(anyPartial && demotion.global ? ['a dynamic t() call with no static prefix exists'] : []),
    ...hiddenCauses,
  ];
  const degradedReason = !degraded
    ? undefined
    : unprovableCauses.length > 0
      ? `cannot prove any key dead — ${unprovableCauses.join(' and ')}`
      : `a dynamic t(\`…\`) demotes namespace(s) ${nameWithMore([...reached], REASON_NS_CAP)} — unrelated keys stay certain`;

  return {
    degraded,
    ...(degradedReason !== undefined ? { degradedReason } : {}),
    // Naming a call is then necessary but NOT sufficient — a consumer's remedy line must say so
    // rather than send the caller to a repair that leaves the verdict identical.
    nonCallCause: hiddenCauses.length > 0,
    // WHOLE-SCAN: a caller already narrowed INTO a demoted namespace sees no provable row of its
    // own, which says nothing about whether narrowing ELSEWHERE would return one.
    anyProvableKey:
      !globalDemote && [...input.allKeys].some((k) => !isKeyDemoted(k, false, demotedPrefixes)),
  };
}
