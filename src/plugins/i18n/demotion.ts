// Reduce a scan's dynamic call sites to a demotion decision (backlog I-a), plus the per-SITE
// attribution (`bounds` / `blockingCalls`) that lets an answer name the calls blocking IT. A template literal
// with a static head demotes only its namespace; an identifier / computed / leading-substitution
// call has no head → the whole scan degrades. Kept out of plugin.ts (300-line cap) and pure so
// the unused-keys honesty is unit-testable in isolation.

import type { Span } from '../../core/span.ts';
import { staticDynamicPrefix } from './dynamic-prefix.ts';

/** One dynamic call and the bound it is provably confined to — the per-SITE attribution behind
 *  the aggregate verdict, so an answer can name the calls that block IT (§3.2 proof-carrying).
 *  `head` absent = no provable bound: this call can produce ANY key. */
export type DynamicCallBound = {
  span: Span;
  head?: string;
};

export type DynamicDemotion = {
  /** A dynamic call with no usable static head exists → EVERY key is unprovable. */
  global: boolean;
  /** Static namespace heads that scope the demotion (sorted, unique). Empty when `global`. */
  prefixes: readonly string[];
  /** Every dynamic call with its bound, ordered by `file:line:col` — a deterministic blocker
   *  order, so a display cap picks the same sites cold and warm (§16 invariant 3). */
  bounds: readonly DynamicCallBound[];
};

const byLoc = (a: DynamicCallBound, b: DynamicCallBound): number =>
  a.span.file !== b.span.file
    ? a.span.file < b.span.file
      ? -1
      : 1
    : a.span.line !== b.span.line
      ? a.span.line - b.span.line
      : a.span.col - b.span.col;

export function dynamicDemotion(dynamicSpans: readonly Span[]): DynamicDemotion {
  const prefixes = new Set<string>();
  const bounds: DynamicCallBound[] = [];
  let global = false;
  for (const span of dynamicSpans) {
    const head = staticDynamicPrefix(span);
    if (head === undefined) global = true;
    else prefixes.add(head);
    bounds.push(head === undefined ? { span } : { span, head });
  }
  bounds.sort(byLoc);
  return global
    ? { global: true, prefixes: [], bounds }
    : { global: false, prefixes: [...prefixes].sort(), bounds };
}

/** The dynamic calls a caller must change for the REPORTED keys to become provable — the CAUSAL
 *  set, not merely the reaching one. Naming a call whose repair changes nothing is a false remedy
 *  (§3.6) and a false proof of the verdict (§3.2), so the selection follows the demotion's own
 *  cause:
 *
 *  - a headless call in effect (`demotion.global`) → ONLY the headless calls. A headed call is
 *    subsumed (its namespace is demoted whatever happens), so it is not what stands between the
 *    caller and a provable answer;
 *  - `globalDemote` for a cause that is NOT a call (a locale parse failure, an unresolved i18n
 *    module) → EMPTY: no call is to blame, and blaming the nearest one sends the caller to a site
 *    whose repair leaves the verdict identical;
 *  - a namespace-scoped demote → the headed calls whose head covers a reported key.
 *
 *  Necessary, never sufficient: when `degradedReason` names a hidden cause ALONGSIDE a headless
 *  call, fixing every site here still leaves that cause standing. */
export function blockingCalls(
  demotion: DynamicDemotion,
  reportedKeys: readonly string[],
  globalDemote: boolean,
): readonly Span[] {
  if (reportedKeys.length === 0) return [];
  if (demotion.global)
    return demotion.bounds.filter((b) => b.head === undefined).map((b) => b.span);
  if (globalDemote) return [];
  return demotion.bounds
    .filter(({ head }) => head !== undefined && reportedKeys.some((k) => k.startsWith(head)))
    .map((b) => b.span);
}

/** A key is demoted iff the scan is GLOBALLY demoted (`globalDemote`), or the key falls under a
 *  demoted head. Whole-scan by construction — never scoped to what an answer reports. */
export function isKeyDemoted(key: string, global: boolean, prefixes: readonly string[]): boolean {
  if (global) return true;
  return prefixes.some((p) => key.startsWith(p));
}
