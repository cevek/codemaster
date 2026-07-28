// Reduce a scan's dynamic call sites to a demotion decision (backlog I-a). A template literal
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

/** The dynamic calls whose bound reaches at least one of `reportedKeys` — the sites that must
 *  change for THOSE keys to become provable. A headless call reaches every key; a headed one only
 *  its own namespace. Empty when the demotion's cause is not a call (a locale parse failure, an
 *  unresolved i18n module) or when nothing is reported — never a site the answer does not rest on. */
export function blockingCalls(
  bounds: readonly DynamicCallBound[],
  reportedKeys: readonly string[],
): readonly Span[] {
  return bounds
    .filter(({ head }) =>
      head === undefined ? reportedKeys.length > 0 : reportedKeys.some((k) => k.startsWith(head)),
    )
    .map((b) => b.span);
}

/** A key is demoted iff the scan degraded globally, or the key falls under a demoted head. */
export function isKeyDemoted(key: string, global: boolean, prefixes: readonly string[]): boolean {
  if (global) return true;
  return prefixes.some((p) => key.startsWith(p));
}
