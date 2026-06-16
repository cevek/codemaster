// Reduce a scan's dynamic call sites to a demotion decision (backlog I-a). A template literal
// with a static head demotes only its namespace; an identifier / computed / leading-substitution
// call has no head → the whole scan degrades. Kept out of plugin.ts (300-line cap) and pure so
// the unused-keys honesty is unit-testable in isolation.

import type { Span } from '../../core/span.ts';
import { staticDynamicPrefix } from './dynamic-prefix.ts';

export type DynamicDemotion = {
  /** A dynamic call with no usable static head exists → EVERY key is unprovable. */
  global: boolean;
  /** Static namespace heads that scope the demotion (sorted, unique). Empty when `global`. */
  prefixes: readonly string[];
};

export function dynamicDemotion(dynamicSpans: readonly Span[]): DynamicDemotion {
  const prefixes = new Set<string>();
  let global = false;
  for (const span of dynamicSpans) {
    const head = staticDynamicPrefix(span);
    if (head === undefined) global = true;
    else prefixes.add(head);
  }
  return global
    ? { global: true, prefixes: [] }
    : { global: false, prefixes: [...prefixes].sort() };
}

/** A key is demoted iff the scan degraded globally, or the key falls under a demoted head. */
export function isKeyDemoted(key: string, global: boolean, prefixes: readonly string[]): boolean {
  if (global) return true;
  return prefixes.some((p) => key.startsWith(p));
}
