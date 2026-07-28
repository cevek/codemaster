// The `props` half of `find_usages` (t-109741) — the JSX prop filter's op-level policy: the
// arg-shape normalization, the role-conflict refusal, and the honesty disclosures. Split from the
// op module purely to keep it under the line cap; the matching itself lives in the ts plugin
// (`jsx-prop-filter.ts`), which is where the AST facts are.

import { z } from 'zod';
import type { UsagesView } from '../plugins/ts/query-types.ts';

/** The op's `props` arg (spread into `find_usages`'s strictObject): keep only `<X …/>` sites
 *  passing these props. `true` = passed with ANY value; a string / string[] = passed with one of
 *  these LITERAL values. Several entries are AND-ed. Implies `role:'jsx'` — an explicit other
 *  role is refused (PROPS_ROLE_CONFLICT), never silently rewritten. */
export const propsArgShape = {
  props: z
    .record(
      z.string().min(1),
      z.union([
        z.literal(true),
        z.string(),
        // `{dirtyGuard: false}` / `{count: 0}` — the spelling an agent reaches for first; compared
        // against the NORMALIZED literal text, so it means the same as `'false'` / `'0'`.
        // (`true` is reserved for "passed with ANY value" — ask the literal as `['true']`.)
        z.literal(false),
        z.number(),
        z.array(z.union([z.string(), z.boolean(), z.number()])).min(1),
      ]),
    )
    .refine((p) => Object.keys(p).length > 0, { message: 'props: at least one prop name' })
    .optional(),
};

/** The verdict-first (§12) uncertainty counts, as a spreadable data field — present only when a
 *  `props` filter actually ran, so `{dynamicValue:0, spreadMaybe:0}` is a MEASURED "no fog". */
export function propsUncertainField(view: UsagesView): Record<string, never> | object {
  return view.propsUncertain !== undefined ? { propsUncertain: view.propsUncertain } : {};
}

/** Under groupBy the `props` FILTER still applies (it runs before the rollup — the sweep question
 *  is answered), but the per-site value annotation has no home on an encloser row; say which half
 *  was dropped rather than let the absence read as "no props matched" (§3.6). */
export const PROPS_GROUPBY_NOTE =
  'props filter applied before the rollup; per-site prop VALUES are a flat-mode annotation — drop groupBy to read them';
/** `props` addresses JSX attributes, so the question is a JSX one. An explicit non-jsx `role`
 *  beside it is refused rather than silently rewritten — quietly answering a different question
 *  than the one asked is the §3.6 lie (t-109741). */
export const PROPS_ROLE_CONFLICT =
  "props filters JSX attributes and applies to role:'jsx' only — drop the role (jsx is implied) or drop props";

/** Normalize the op-level `props` arg (a scalar value is one-of-one) to the plugin's filter shape. */
export function propFilterOf(
  props: Record<string, PropArg> | undefined,
): Record<string, true | readonly string[]> | undefined {
  if (props === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(props).map(([k, v]) => [
      k,
      v === true ? true : Array.isArray(v) ? v.map(String) : [String(v)],
    ]),
  );
}

/** One `props` entry as the agent may spell it: `true` (any value), or the literal value(s). */
type PropArg = true | string | false | number | (string | boolean | number)[];

/** The `!!` uncertainty note for a props-filtered answer — the two causes stay APART because
 *  their remedies are different reads (the expression vs what's in the spread). Empty when the
 *  filter ran with everything statically readable (a measured "no fog"). */
export function propsUncertaintyNotes(u: { dynamicValue: number; spreadMaybe: number }): string[] {
  const notes: string[] = [];
  if (u.dynamicValue > 0) {
    notes.push(
      `!! ${u.dynamicValue} site(s) pass the prop with a NON-LITERAL value (confidence=dynamic) — the value is in the row, read the expression to decide`,
    );
  }
  if (u.spreadMaybe > 0) {
    notes.push(
      `!! ${u.spreadMaybe} site(s) match only because a {...spread} may carry or override the prop (confidence=dynamic) — read what the spread holds`,
    );
  }
  return notes;
}
