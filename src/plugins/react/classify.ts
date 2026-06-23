// Generic declaration classification — "is this a component, a hook, or neither?" — the react
// CONVENTION applied to a resolved `ts` declaration (§5-L2). The policy ("what is a component")
// lives HERE, never in the `ts` plugin. Domain-neutral on purpose: trace ops walk a chain of
// declarations and must route each one (a component → mount it; a hook → follow its callers),
// so this is shared foundation — trace_invalidation today, trace-prop-through-tree /
// trace-field-to-render (Wave 2b) on the same seam.
//
// Resolution is by the declaration's name-token LOCATION (via `ts.findDefinition`), never an
// id-string compare — a SymbolId minted by one path (`mintSymbolId`) and an encloser id minted by
// another (`mintEncloserId`) can encode the same declaration differently, so we resolve, then match
// the `functionDeclarations()` decl at that loc (the `unused-props` pickComponent precedent).

import type { Span } from '../../core/span.ts';
import type { FunctionDecl } from '../ts/function-declarations.ts';
import { isComponentName, isHookName } from './conventions.ts';

export type DeclKind = 'component' | 'hook' | 'other';

/** A classified declaration. `span` is the name-token span — proof AND a chainable target
 *  (`resolveTarget` accepts file:line:col), so a caller chains `jsxCallSites` / `find_usages`
 *  off it without re-resolving. `confidence` rides the underlying JSX-return fact for a
 *  component (a wrapped/ternary return is `dynamic`/`partial`), `certain` for a hook. */
export type DeclClassification = {
  kind: DeclKind;
  name: string;
  span: Span;
  confidence: FunctionDecl['returnsJsxConfidence'];
};

/** Classify a resolved declaration by the react conventions. A PascalCase decl that syntactically
 *  returns JSX is a `component`; a `useX` decl is a `hook`; anything else is `other` (a caller stops
 *  the walk there). Hook is checked first only for non-component names — a PascalCase `useThing`
 *  cannot occur (the predicates are disjoint on the first char), so order is immaterial. */
export function classifyDecl(decl: FunctionDecl): DeclClassification {
  if (isComponentName(decl.name) && decl.returnsJsx) {
    return {
      kind: 'component',
      name: decl.name,
      span: decl.span,
      confidence: decl.returnsJsxConfidence,
    };
  }
  if (isHookName(decl.name)) {
    return { kind: 'hook', name: decl.name, span: decl.span, confidence: 'certain' };
  }
  return { kind: 'other', name: decl.name, span: decl.span, confidence: decl.returnsJsxConfidence };
}

/** Find the `functionDeclarations()` decl whose name-token span sits at `loc` (the location a
 *  target resolved to). Exact file+line+col match — both spans are name tokens, so they coincide. */
export function declAt(
  decls: readonly FunctionDecl[],
  loc: { file: string; line: number; col: number },
): FunctionDecl | undefined {
  return decls.find(
    (d) => d.span.file === loc.file && d.span.line === loc.line && d.span.col === loc.col,
  );
}
