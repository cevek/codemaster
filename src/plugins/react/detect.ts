// Component / hook detection — the React CONVENTION applied to the `ts` plugin's
// framework-neutral `functionDeclarations()` scan (§4/§5-L2). The `ts` plugin emits the
// syntactic facts (name, kind, returnsJsx + confidence); the React reading of them lives
// here. Every entry is a HEURISTIC (provenance `heuristic:react`, §3.3); confidence tracks
// the underlying JSX fact, never asserted beyond what the syntactic scan proved.
//
// HONEST UNDER-REPORT (§3.6): `returnsJsx` is syntactic — a function that returns JSX only
// INDIRECTLY (`const el = <x/>; return el`, or `return getJsx()`) has `returnsJsx === false`
// and is NOT flagged a component. This is a checker-free under-report (never a fabrication);
// the components registry carries `COMPONENTS_NOTE` so the agent sees the boundary.

import type { ListEntry } from '../../core/list.ts';
import type { Provenance } from '../../core/span.ts';
import type { FunctionDecl } from '../ts/function-declarations.ts';
import { isComponentName, isHookName } from './conventions.ts';

const REACT_PROV: Provenance = { kind: 'heuristic', by: 'react' };

export const COMPONENTS_NOTE =
  'components detected by SYNTACTIC JSX-return; a PascalCase function returning JSX only indirectly (via a variable or call) is NOT flagged (honest under-report, never guessed). A `call-wrapped` form (forwardRef/memo) is `dynamic`.';

/** A component: a PascalCase name whose declaration syntactically returns JSX. Confidence is
 *  the scan's `returnsJsxConfidence` (direct = certain; ternary/mixed = partial; wrapped = dynamic). */
export function detectComponents(decls: readonly FunctionDecl[]): ListEntry[] {
  const out: ListEntry[] = [];
  for (const d of decls) {
    if (!isComponentName(d.name) || !d.returnsJsx) continue;
    out.push({
      name: d.name,
      kind: 'component',
      span: d.span,
      confidence: d.returnsJsxConfidence,
      provenance: REACT_PROV,
      ...(d.kind === 'call-wrapped'
        ? { detail: 'wrapped (forwardRef/memo) — JSX inferred through the wrapper' }
        : {}),
    });
  }
  return out;
}

/** A custom hook: a `use[A-Z]…` name on a function-like declaration. The naming convention is a
 *  syntactic match (`certain`) but a heuristic inference (`provenance: heuristic:react`) — a `useX`
 *  helper that is not really a hook is the convention's false positive, owned here, not in `ts`. */
export function detectHooks(decls: readonly FunctionDecl[]): ListEntry[] {
  const out: ListEntry[] = [];
  for (const d of decls) {
    if (!isHookName(d.name)) continue;
    out.push({
      name: d.name,
      kind: 'hook',
      span: d.span,
      confidence: 'certain',
      provenance: REACT_PROV,
    });
  }
  return out;
}
