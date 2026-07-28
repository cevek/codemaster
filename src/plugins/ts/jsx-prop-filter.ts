// "Which `<X/>` sites pass THIS prop (with THIS value)" — the match rule behind `find_usages`'s
// `props` filter. Pure: it decides over an already-read `JsxSiteAttrs`, so the AST read
// (`jsx-attr-values.ts`) and the policy here stay separable and independently testable.
//
// The rule exists to answer an audit ("every consumer of this escape-hatch / variant prop"), so
// its bias is EXPLICIT: a site whose answer is not statically knowable is KEPT and flagged, never
// dropped — a dropped uncertain site is exactly the silent miss the filter is for (§3.3/§3.4).
// Two DISTINCT uncertainties, never merged into one count, because their remedies differ:
//   dynamicValue — the prop IS passed, its value is an expression  → read the expression
//   spreadMaybe  — a `{...spread}` may carry (or override) the prop → read what's in the spread

import type { Confidence } from '../../core/span.ts';
import type { JsxAttrValue, JsxSiteAttrs } from './jsx-attr-values.ts';

/** `true` = "passed at all, any value"; a value list = "passed with one of these literal values".
 *  Several entries are AND-ed (every requested prop must match at the site). */
export type PropFilter = Readonly<Record<string, true | readonly string[]>>;

export type PropMatch = {
  /** Requested props actually present at the site (proof for the row); absent ones are not
   *  fabricated — a spread-only candidate legitimately carries none. */
  props: JsxAttrValue[];
  /** The site carries a `{...spread}`. */
  spread: boolean;
  confidence: Confidence;
  /** At least one requested prop is present with a non-static value. */
  dynamicValue: boolean;
  /** The match rests (wholly or partly) on a spread that MAY carry/override the prop. */
  spreadMaybe: boolean;
};

/** Decide one site. `undefined` = does not match the filter (the site is excluded, and the caller
 *  counts it — an exclusion is never silent).
 *
 *  SPREAD ORDER IS LOAD-BEARING. JSX takes the LAST writer, so a `{...spread}` sitting AFTER an
 *  attribute can override it: `<X variant="contained" {...rest}/>` may in fact render `"text"`, and
 *  `<X {...rest} variant="text"/>` definitely renders `"text"` whatever the spread holds. So a
 *  spread makes an answer uncertain only when it comes after the attribute it could overwrite (an
 *  ABSENT prop can be delivered by a spread in any position). */
export function matchProps(site: JsxSiteAttrs, filter: PropFilter): PropMatch | undefined {
  const props: JsxAttrValue[] = [];
  let dynamicValue = false;
  let spreadMaybe = false;
  for (const [name, want] of Object.entries(filter)) {
    // `findLast`, not `find`: JSX takes the LAST writer, so a duplicated attribute resolves to the
    // later one (the same rule the spread-order check below applies).
    const attr = site.attrs.findLast((a) => a.name === name);
    if (attr === undefined) {
      // Absent: only a spread can still deliver it. Without one this is a definite non-match.
      if (!site.hasSpread) return undefined;
      spreadMaybe = true;
      continue;
    }
    props.push(attr);
    // A later spread can overwrite this attribute — whatever we read here may not be what renders.
    const overridable = attr.index < site.lastSpreadIndex;
    // A non-literal value is COUNTED whichever question was asked — the count is "how many sites
    // still need a human read", not a confidence. Under `want === true` presence stays PROVEN (a
    // spread cannot un-pass a prop), so such a site is still `certain`; but a `dynamicValue:0`
    // beside a `{!isView}` row would be the summary channel lying about its own body.
    if (attr.kind === 'dynamic') dynamicValue = true;
    if (want === true) continue; // presence asked, presence proven — value fog is counted, not fatal
    if (overridable) {
      spreadMaybe = true; // the value we matched (or rejected) may be overwritten downstream
      continue;
    }
    if (attr.kind === 'dynamic') continue; // value unknowable → the match itself is dynamic (below)
    if (want.includes(attr.value)) continue;
    return undefined; // a literal outside the set, with no spread after it — a DEFINITE non-match
  }
  return {
    props,
    spread: site.hasSpread,
    // The MATCH's own certainty: an unreadable value or an overridable one. A counted `dynamicValue`
    // under a presence question does not demote (presence is proven either way).
    confidence:
      spreadMaybe || props.some((a) => a.kind === 'dynamic' && filter[a.name] !== true)
        ? 'dynamic'
        : 'certain',
    dynamicValue,
    spreadMaybe,
  };
}
