// The typed registry of per-string type/signature caps — the compile mirror of the `~shape`
// `Record<Tag, mode>` precedent (§12): a new `CapId` with no descriptor is a COMPILE error, so a
// cap can never be added without declaring its value AND its recovery marker. This forces
// marker-and-verbosity to attach to a cap BY CONSTRUCTION (`elideType`), which is what stops the
// class of "capped a type string with a silent `…`" from recurring (§3.4). Scope: type/signature
// STRINGS whose cap is a compile-time constant — the runtime `limit` caps (result-set lists) ride
// `capList`, not this registry.

import type { Verbosity } from '../../core/result.ts';

/** How a cut string tells the agent how to get the rest.
 *  - `verbosity` — the owning op threads `verbosity:full` (which lifts the cap): recover by re-asking at full.
 *  - `verbosity+param` — a signature: `verbosity:full`, or `expand_type` the param type directly.
 *  - `length-only` — the owning op does NOT thread `verbosity:full`, so it is NOT a valid recovery;
 *    the marker reports only the full length (offering a bogus `verbosity:full` would be a lie, §3.6). */
export type CapRecover = 'verbosity' | 'verbosity+param' | 'length-only';

export interface CapDescriptor {
  /** Per-string cap at the default verbosity. */
  value: number;
  /** Per-string cap at `verbosity:full` — a large FINITE bound so the per-item marker still fires
   *  before the blunt §12 render cap (never Infinity, §1). Omitted when the cap is NOT
   *  verbosity-aware (a `length-only` site whose op never threads verbosity): full reuses `value`. */
  valueFull?: number;
  /** The rendered noun in the marker (`(type elided …)` / `(signature elided …)`). */
  kind: 'type' | 'signature';
  /** How the marker states recovery — see `CapRecover`. */
  recover: CapRecover;
}

/** Every per-string type/signature cap in the tree, by identity. */
export type CapId =
  | 'expand-type-type'
  | 'expand-type-signature'
  | 'first-param-member-type'
  | 'overlay-type'
  | 'type-widening';

/** Exhaustive `Record<CapId, …>` — the compile gate: a new `CapId` without an entry fails `tsc`.
 *  The twins (`first-param-member-type` / `overlay-type` / `type-widening`) are `length-only`: their
 *  ops (`find_unused_props` / `impact_type_error` / `trace_type_widening`) do not thread
 *  `verbosity:full`, so their marker reports the full length WITHOUT a `verbosity:full` steer. */
export const CAP_DESCRIPTORS: Record<CapId, CapDescriptor> = {
  'expand-type-type': { value: 200, valueFull: 10_000, kind: 'type', recover: 'verbosity' },
  'expand-type-signature': {
    value: 200,
    valueFull: 10_000,
    kind: 'signature',
    recover: 'verbosity+param',
  },
  'first-param-member-type': { value: 200, kind: 'type', recover: 'length-only' },
  'overlay-type': { value: 200, kind: 'type', recover: 'length-only' },
  'type-widening': { value: 200, kind: 'type', recover: 'length-only' },
};

/** The effective cap for a descriptor at a given verbosity — `valueFull` at `full` when the cap is
 *  verbosity-aware, else `value`. */
export function capFor(desc: CapDescriptor, verbosity: Verbosity): number {
  return verbosity === 'full' && desc.valueFull !== undefined ? desc.valueFull : desc.value;
}
