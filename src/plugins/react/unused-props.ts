// The unused-props read-model — the react CONVENTION applied over two framework-neutral `ts`
// seams (§5-L2): `firstParamTypeMembers` (a component's DECLARED props — first param = props is
// the policy owned HERE) and `jsxCallSites` (the props each `<C .../>` site PASSES). This module
// is the reusable "component → declared props vs passed props" capability; downstream trace ops
// (trace-prop-through-tree, …) sit on the same two seams.
//
// HONESTY (the #1 risk — a live prop falsely called dead, §3): a prop is `certain`-unused ONLY
// when EVERY reference of the component is a cleanly-readable `<C .../>` site with no `{...spread}`.
// Any spread, any factory `createElement` / value reference (`memo(C)`, `const D = C`), or a capped
// reference set makes the passed set unreadable → the WHOLE candidate set demotes to `partial`
// (could-not-prove-dead), never a false `certain`. Over-demotion is honest; false-certain is fatal.

import type { Confidence } from '../../core/span.ts';
import type { Span } from '../../core/span.ts';
import type { FunctionDecl } from '../ts/function-declarations.ts';
import type { JsxCallSitesView, ParamTypeMembersView } from '../ts/plugin.ts';
import { isComponentName } from './conventions.ts';

export type UnusedProp = {
  name: string;
  optional: boolean;
  inherited?: boolean;
  type: string;
  /** `certain` (no readable site passes it AND the passed set is fully readable) or `partial`
   *  (the set was demoted — see `demoteReasons`). */
  confidence: Confidence;
  span?: Span;
};

export type UnusedPropsView = {
  /** The resolved component (name-token span = proof + chainable target). */
  component: { name: string; span: Span };
  declaredCount: number;
  /** Distinct prop names observed passed across all readable JSX sites. */
  passedCount: number;
  /** Readable `<C .../>` call-sites inspected. */
  callSiteCount: number;
  unused: UnusedProp[];
  /** True when the verdicts are demoted to `partial` (spread / opaque ref / truncation). */
  demoted: boolean;
  /** Why the set was demoted — empty when every verdict is `certain`. */
  demoteReasons: string[];
  /** The function takes no first parameter — no props to declare. */
  noParam: boolean;
  /** Declared-member set was capped (from the ts seam). */
  truncatedMembers?: { shown: number; total: number };
};

export type PickResult = { ok: true; decl: FunctionDecl } | { ok: false; message: string };

/** The plugin method's result — the view, or an honest message (component not found / ambiguous /
 *  a ts-seam miss). Never a fabricated empty success. */
export type UnusedPropsResult =
  | { ok: true; view: UnusedPropsView }
  | { ok: false; message: string };

/** Resolve a component by name (react policy: PascalCase + returns-JSX), optionally scoped to a
 *  file. Honest on 0 (not a detected component) and >1 (ambiguous — lists the files). */
export function pickComponent(
  decls: readonly FunctionDecl[],
  name: string,
  file?: string,
): PickResult {
  const matches = decls.filter(
    (d) =>
      d.name === name &&
      isComponentName(d.name) &&
      d.returnsJsx &&
      (file === undefined || d.span.file === file),
  );
  if (matches.length === 0) {
    return {
      ok: false,
      message: `no detected React component named '${name}'${
        file !== undefined ? ` in ${file}` : ''
      } — unused_props applies to a PascalCase function that returns JSX`,
    };
  }
  if (matches.length > 1) {
    const where = matches.map((d) => `${d.span.file}:${d.span.line}`).join(', ');
    return {
      ok: false,
      message: `'${name}' is ambiguous (${matches.length} components: ${where}) — pass file: to disambiguate`,
    };
  }
  // matches.length === 1, guarded above.
  const decl = matches[0];
  if (decl === undefined) return { ok: false, message: `no component named '${name}'` };
  return { ok: true, decl };
}

/** Diff declared props against passed props, applying the §3 demotion. Pure. */
export function computeUnusedProps(
  decl: FunctionDecl,
  declared: ParamTypeMembersView,
  jsx: JsxCallSitesView,
): UnusedPropsView {
  const passed = new Set<string>();
  for (const site of jsx.sites) for (const attr of site.attrNames) passed.add(attr);

  const reasons: string[] = [];
  if (jsx.sites.some((s) => s.hasSpread)) {
    reasons.push('a JSX call-site spreads props ({...x}) — any prop could be passed there');
  }
  if (jsx.opaqueRefs.length > 0) {
    reasons.push(
      `${jsx.opaqueRefs.length} reference(s) pass props unreadably (a createElement/factory call, or a value use like memo(C) / const D = C)`,
    );
  }
  if (jsx.truncated !== undefined) {
    reasons.push(
      `JSX call-sites capped at ${jsx.truncated.shown}/${jsx.truncated.total} — unseen sites may pass a prop`,
    );
  }
  const demoted = reasons.length > 0;
  const confidence: Confidence = demoted ? 'partial' : 'certain';

  const unused: UnusedProp[] = [];
  for (const m of declared.members) {
    if (passed.has(m.name)) continue; // passed at some readable site → used
    unused.push({
      name: m.name,
      optional: m.optional,
      type: m.type,
      ...(m.inherited === true ? { inherited: true } : {}),
      ...(m.span !== undefined ? { span: m.span } : {}),
      confidence,
    });
  }

  return {
    component: { name: decl.name, span: decl.span },
    declaredCount: declared.members.length,
    passedCount: passed.size,
    callSiteCount: jsx.sites.length,
    unused,
    demoted,
    demoteReasons: reasons,
    noParam: declared.noParam,
    ...(declared.truncated !== undefined ? { truncatedMembers: declared.truncated } : {}),
  };
}
