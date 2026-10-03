// The write gate's host-lifetime context: what one host holds for the whole gate — the result memo
// (program-gate-cache.ts) and the per-program diagnostics builders (program-gate-builder.ts) — over
// a program list re-read per gate (`built()` materializes the siblings).

import type { SingleProgram } from './program/single.ts';
import type { GateHostCtx } from './program-gate.ts';
import { createGateCache } from './program-gate-cache.ts';
import { createGateBuilders } from './program-gate-builder.ts';

export function gateContext(
  base: Omit<GateHostCtx, 'programs' | 'cache' | 'builders'> & {
    programs: () => readonly SingleProgram[];
  },
): () => GateHostCtx {
  const cache = createGateCache();
  const builders = createGateBuilders();
  return () => ({ ...base, programs: base.programs(), cache, builders });
}
