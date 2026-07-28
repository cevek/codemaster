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
 *  counts it — an exclusion is never silent). */
export function matchProps(site: JsxSiteAttrs, filter: PropFilter): PropMatch | undefined {
  const props: JsxAttrValue[] = [];
  let dynamicValue = false;
  let spreadMaybe = false;
  for (const [name, want] of Object.entries(filter)) {
    const attr = site.attrs.find((a) => a.name === name);
    if (attr === undefined) {
      // Absent: only a spread can still deliver it. Without one this is a definite non-match.
      if (!site.hasSpread) return undefined;
      spreadMaybe = true;
      continue;
    }
    props.push(attr);
    if (want === true) continue; // presence asked, presence proven — certain even for a dynamic value
    if (attr.kind === 'dynamic') {
      dynamicValue = true; // passed, value unknowable — kept and flagged, never dropped
      continue;
    }
    if (want.includes(attr.value)) continue;
    // A literal outside the requested set — but a spread can OVERRIDE an explicit attribute,
    // so silently excluding such a site would be the very miss this filter prevents.
    if (!site.hasSpread) return undefined;
    spreadMaybe = true;
  }
  return {
    props,
    spread: site.hasSpread,
    confidence: dynamicValue || spreadMaybe ? 'dynamic' : 'certain',
    dynamicValue,
    spreadMaybe,
  };
}
