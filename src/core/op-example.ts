// A structured, machine-checkable example call for an op (§1.1). Stored on
// `OpDefinition` (L3 ops) and surfaced through `OpStatusView` (L0 format) — so it lives
// in `core/` (the leaf both layers may import) to avoid an ops↔format cycle. The
// formatter composes the display string from it in one canonical shape (exact tool-args
// JSON); the anti-drift test parses `args` back through the op's own zod `argsSchema`, so
// a drifted example becomes a failing test, permanently.

import type { JsonValue } from './json.ts';
import type { Verbosity } from './result.ts';

/** The agent-visible flags an example may demonstrate (a subset of `OpFlags` plus the
 *  batch-level `sql`). Kept narrow on purpose: examples teach call shape, not every knob. */
interface OpExampleFlags {
  verbosity?: Verbosity;
  sql?: string;
  apply?: boolean;
  format?: 'text' | 'json';
}

/** A canonical example of one op call: the `args` object an agent would pass, plus any
 *  flags worth showing. `args` must validate against the op's `argsSchema`. */
export interface OpExample {
  args: JsonValue;
  flags?: OpExampleFlags;
}
