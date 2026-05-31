import type { RepoRelPath } from './brands.js';

// The proof primitives every layer speaks: a location, a verbatim source span, and the
// confidence attached to a fact. Kept in their own leaf module so `result`, `ids`, and
// the primitives can build on them without forming an import cycle.

/** A point in a source file. **1-based** line and column, to match editors and the
 *  clickable `file:line` convention.
 *
 *  The TS compiler is 0-based (offsets, and 0-based line/char from
 *  `getLineAndCharacterOfPosition`). Convert at the foundation boundary, in one place —
 *  never let the two conventions mix, or proof spans drift by one. */
export interface Loc {
  file: RepoRelPath;
  line: number;
  col: number;
}

/** A proof span: an exact source range plus the verbatim text it covers — what lets an
 *  agent confirm a claim without re-grepping. */
export interface Span extends Loc {
  endLine: number;
  endCol: number;
  /** Verbatim source text of the span. May be elided for very large spans. */
  text: string;
  elided?: boolean;
}

/** How sure are we? "Never lie" means uncertainty is explicit, never silent. */
export type Confidence =
  | 'certain' // proven by the TS type system / exact structural match
  | 'partial' // found, but incomplete (e.g. some refs in dynamic positions)
  | 'unresolved' // a binding/type we could not resolve (any, untyped boundary)
  | 'dynamic'; // resolved only through a dynamic hop (callback, computed key)

/** How a fact or edge was *derived* — orthogonal to `Confidence` (how sure we are). Lets
 *  the agent see whether a relationship is proven by the type system, read off the syntax,
 *  or inferred by an adapter heuristic — and which one. */
export interface Provenance {
  kind: 'syntactic' | 'type' | 'heuristic';
  /** The adapter or heuristic that produced it, when `heuristic` — e.g. 'react-query'. */
  by?: string;
}
