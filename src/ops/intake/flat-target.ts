// Collapse a flat single-symbol addressing into an op's canonical target-ARRAY field (§7
// Postel) — `source`'s recurring papercut: every sibling lookup op takes a flat `{name}` /
// `{symbolId}` / `{file+line+col}`, but `source` alone requires `{targets:[…]}`. When the op
// names its array field (`OpIntake.targetArray`) and the caller passed NO explicit array key,
// a flat single target (the shared tsTarget keys) or a `{names:[…]}` list is gathered into a
// one/N-element `targets[]`. An explicit `targets` always wins (never clobbered).
//
// The gathered keys are the FIXED tsTarget set (`TS_TARGET_KEYS`, shared with the shape) + a
// non-empty `names` — any OTHER key, and an EMPTY `names:[]` (a meaningless intent), is left in
// place and flows to the canonical gate (an honest reject, never a silent strip, §3). Builds
// fresh element objects (no mutation of shared nested refs — `args` is a shallow clone).

import { TS_TARGET_KEYS } from '../ts-target.ts';

export interface FlatTargetResult {
  notes: string[];
}

/** Collapse flat target keys into `args[field]` when `field` is absent, mutating `args`. */
export function collapseFlatTarget(
  args: Record<string, unknown>,
  field: string | undefined,
): FlatTargetResult {
  if (field === undefined || field in args) return { notes: [] };
  const targets: Array<Record<string, unknown>> = [];

  // `{names:[…]}` — the multi-name spelling — becomes N single-name targets. An EMPTY list is
  // left untouched (a meaningless intent the gate rejects), never silently consumed.
  const names = args['names'];
  if (Array.isArray(names) && names.length > 0) {
    for (const n of names) targets.push({ name: n });
    delete args['names'];
  }

  // A flat single target from the shared tsTarget keys.
  const single: Record<string, unknown> = {};
  for (const key of TS_TARGET_KEYS) {
    if (key in args) {
      single[key] = args[key];
      delete args[key];
    }
  }
  if (Object.keys(single).length > 0) targets.push(single);

  if (targets.length === 0) return { notes: [] };
  args[field] = targets;
  return { notes: [`flat→${field}[]`] };
}
