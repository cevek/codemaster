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
// The demotion is computed over the SITES, so it is orthogonal to (and survives) any narrowing of
// the MEMBER set below.
//
// VIEW NARROWING (t-997783). Two independent filters over the declared members — never over the
// sites, so no honesty channel is touched:
//   · default — props declared OUTSIDE the repo's own source (`prop-origin.ts`) are omitted and
//     COUNTED (`hiddenExternal`), because a wrapper over `React.ComponentProps<'button'>` buries
//     its one own prop under ~290 DOM/aria members the repo can neither read nor delete.
//   · `prop` — an EXPLICIT name list, which overrides the default narrowing (the caller named the
//     prop; where it was declared is not the question) and answers per name in three distinct
//     states, since a bare `found:0` would merge them: `inUse` (declared and passed somewhere),
//     `notDeclared` (not a member), `undetermined` (absent from a CAPPED member set — a
//     proven-absence claim over a set we did not see is the §3.4 lie, not a "no such prop").

import type { Confidence } from '../../core/span.ts';
import type { Span } from '../../core/span.ts';
import type { FunctionDecl } from '../ts/function-declarations.ts';
import type { JsxCallSitesView, ParamTypeMember, ParamTypeMembersView } from '../ts/plugin.ts';
import { isComponentName } from './conventions.ts';
import { isExternalDeclaration } from './prop-origin.ts';

export type UnusedProp = {
  name: string;
  optional: boolean;
  inherited?: boolean;
  /** Declared outside the repo's own source (node_modules / outside the root) — the set the
   *  default view omits. Distinct from `inherited` (heritage), which can be absent for an
   *  anonymous intersection while this is provable from the declaration file. */
  external?: boolean;
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
  /** Unused props OMITTED from `unused` because they are declared outside the repo's own
   *  source (the default view). Absent when nothing was hidden — so a component with no
   *  external props renders exactly as before. */
  hiddenExternal?: number;
  /** Under `prop`: requested props that ARE passed at ≥1 readable site (declared, not dead). */
  inUse?: string[];
  /** Under `prop`: requested names that are not declared members of this component. */
  notDeclared?: string[];
  /** Under `prop`: requested names absent from a CAPPED member set — neither found nor provably
   *  absent. Never folded into `notDeclared` (that would be a proven absence over an unseen set). */
  undetermined?: string[];
};

/** How the declared-member set is narrowed for the view (both filters are member-level, so the
 *  site-derived demotion is untouched). */
export type UnusedPropsOptions = {
  /** Keep props declared outside the repo's own source (default: omit + count them). */
  includeExternal?: boolean;
  /** Answer for these declared prop names only. Overrides `includeExternal` narrowing. */
  prop?: readonly string[];
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

/** One declared member as a result row — the `external` provenance is stamped here so it is
 *  carried by EVERY row the view emits, whichever filter selected it. */
function toRow(m: ParamTypeMember, confidence: Confidence): UnusedProp {
  return {
    name: m.name,
    optional: m.optional,
    type: m.type,
    ...(m.inherited === true ? { inherited: true } : {}),
    ...(isExternalDeclaration(m.span) ? { external: true } : {}),
    ...(m.span !== undefined ? { span: m.span } : {}),
    confidence,
  };
}

/** The EXPLICIT-name branch: per requested name, one of four states (unused row / `inUse` /
 *  `notDeclared` / `undetermined`). Provenance does not filter here — the caller named the prop. */
function answerRequested(
  requested: readonly string[],
  declared: ParamTypeMembersView,
  passed: ReadonlySet<string>,
  confidence: Confidence,
): Pick<UnusedPropsView, 'unused' | 'inUse' | 'notDeclared' | 'undetermined'> {
  const byName = new Map(declared.members.map((m) => [m.name, m]));
  const unused: UnusedProp[] = [];
  const inUse: string[] = [];
  const notDeclared: string[] = [];
  const undetermined: string[] = [];
  for (const name of new Set(requested)) {
    const member = byName.get(name);
    if (member === undefined) {
      // A capped member set cannot support "not declared" — that is an absence claimed over
      // members we never saw (§3.4/§3.6).
      (declared.truncated !== undefined ? undetermined : notDeclared).push(name);
      continue;
    }
    if (passed.has(name)) inUse.push(name);
    else unused.push(toRow(member, confidence));
  }
  return {
    unused,
    ...(inUse.length > 0 ? { inUse } : {}),
    ...(notDeclared.length > 0 ? { notDeclared } : {}),
    ...(undetermined.length > 0 ? { undetermined } : {}),
  };
}

/** Diff declared props against passed props, applying the §3 demotion. Pure. */
export function computeUnusedProps(
  decl: FunctionDecl,
  declared: ParamTypeMembersView,
  jsx: JsxCallSitesView,
  options: UnusedPropsOptions = {},
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

  // Explicit names answer per name; otherwise the whole declared set, narrowed by provenance.
  let selected: Pick<UnusedPropsView, 'unused' | 'inUse' | 'notDeclared' | 'undetermined'>;
  let hiddenExternal = 0;
  if (options.prop !== undefined) {
    selected = answerRequested(options.prop, declared, passed, confidence);
  } else {
    const unused: UnusedProp[] = [];
    for (const m of declared.members) {
      if (passed.has(m.name)) continue; // passed at some readable site → used
      const row = toRow(m, confidence);
      if (row.external === true && options.includeExternal !== true) {
        hiddenExternal += 1; // omitted from the view, never silently (surfaced below)
        continue;
      }
      unused.push(row);
    }
    selected = { unused };
  }

  return {
    component: { name: decl.name, span: decl.span },
    declaredCount: declared.members.length,
    passedCount: passed.size,
    callSiteCount: jsx.sites.length,
    ...selected,
    demoted,
    demoteReasons: reasons,
    noParam: declared.noParam,
    ...(declared.truncated !== undefined ? { truncatedMembers: declared.truncated } : {}),
    ...(hiddenExternal > 0 ? { hiddenExternal } : {}),
  };
}
