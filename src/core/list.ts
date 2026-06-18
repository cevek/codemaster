// The registry-listing contract (§5-L2 / §11 `list` op). A plugin that owns one or more
// named registries (the `react` plugin's components/hooks/dialogs, the `react-query`
// plugin's queries/mutations/queryKeys, …) exposes them through the optional
// `listRegistries` / `list` members on the base `Plugin` interface (core/plugin.ts) —
// mirroring the optional `statusDetail`, so the generic `list` op routes to the owner
// WITHOUT a per-plugin op and WITHOUT runtime feature-probing of plugin shapes.
//
// Entries are proof-carrying (§3.2): every entry ships its `Span` (file:line + verbatim)
// and an explicit `Confidence` + `Provenance`. A framework plugin's is-a-component /
// is-a-hook inference is a HEURISTIC (provenance.kind === 'heuristic', `by` = the plugin
// id) — never dressed as a structural or type-proven fact (§3.3).

import type { Span, Confidence, Provenance } from './span.ts';

/** One segment of a COMPOSITE key (a react-query `queryKey` like `['todos', <dynamic>]`).
 *  Kept per-segment with an explicit `dynamic` flag rather than flattened into a string,
 *  so a computed segment is reported as `dynamic`, never guessed into a literal (§3.3/§18). */
export interface KeySegment {
  /** The literal value when the segment is a plain string/number literal. Absent when `dynamic`. */
  value?: string;
  /** True when the segment is a variable / interpolation / computed expression. */
  dynamic: boolean;
}

/** One listed item in a registry. A simple registry sets `name`; a composite-key registry
 *  (queryKeys) sets `segments` instead — at least one is present, never both empty. */
export interface ListEntry {
  /** Display name for simple registries (a component / hook / store / route name). */
  name?: string;
  /** Composite-key form (react-query `queryKey`): per-segment, with a `dynamic` flag.
   *  Never flattened into `name` — a dynamic segment stays explicit. */
  segments?: readonly KeySegment[];
  /** Registry-specific item kind, e.g. 'component' | 'hook' | 'dialog' | 'query' | 'mutation'. */
  kind: string;
  /** Proof span: where the item is declared (file:line + verbatim source). */
  span: Span;
  /** Confidence in the UNDERLYING fact (e.g. a direct JSX return = `certain`; a conditional /
   *  computed return = `partial`; an `any`/computed value = `dynamic`). Orthogonal to
   *  `provenance` (an inference can be heuristic yet certain). */
  confidence: Confidence;
  /** How the item was derived. A framework convention inference is always
   *  `{ kind: 'heuristic', by: '<plugin-id>' }` (§3.3). */
  provenance: Provenance;
  /** Optional one-line annotation an agent should see (e.g. the dialog primitive a dialog
   *  component renders). */
  detail?: string;
}

/** The result of listing one registry. `truncation` is set only when the listing was
 *  capped — silent truncation reads as completeness (§3.4). */
export interface ListView {
  /** The registry that was listed (echoed back). */
  registry: string;
  entries: readonly ListEntry[];
  /** A registry-level honesty caveat the agent must see — e.g. a detection that is a
   *  syntactic under-report (the `react` components registry: a component returning JSX
   *  only INDIRECTLY, via a variable/call, is not flagged). Surfaced by the `list` op,
   *  never silent (§3.6). */
  note?: string;
  /** Set only when the entry set was capped. */
  truncation?: { shown: number; total: number; hint: string };
}
