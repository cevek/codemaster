// The CSS-module co-extract SAFETY TAXONOMY (spec-css-coextract §2.7) — ported from
// front-renamer's `classSafetyVerdict` / `selectorIsOwnedBy` / `selectorReferences`, the
// killed bugs of CSS refactoring made into rules. Read-only over a postcss CST.
//
// Governing principle (§1): TypeScript never typechecks a `.scss` import, so a wrong class
// move silently changes styling that no gate can catch. Therefore a class is moved ONLY when
// every check below passes; otherwise it STAYS, tagged with the first failing code.
// Conservative-and-honest beats complete-and-wrong.

import type { Root, Rule } from 'postcss';

/** Reason a class was left behind. Short codes for dense output (§12); the report keeps the
 *  legend so the agent never memorizes them. */
export type LeftBehindCode =
  | 'USED' // still referenced by the source-file remainder (or the remaining-source wildcard)
  | 'NO-RULE' // no rule found whose selector is owned by this class
  | 'COMPOUND' // the class appears in a compound/descendant/sibling selector elsewhere
  | 'NESTED' // the owning rule has nested child rules
  | 'NEST-PARENT' // the owning rule is itself nested inside another selector
  | 'AT-RULE' // the owning rule body uses an unsafe at-rule
  | 'SASS-VAR' // a declaration references a Sass variable ($foo)
  | 'EXTEND' // some rule @extends this class
  | 'COMPOSES' // the rule `composes:` another class, or another rule composes THIS class
  | 'KEYFRAMES' // the rule animates a @keyframes defined in this sheet (scoped, won't travel)
  | 'PARSE-FAIL' // the stylesheet could not be parsed / transformed — nothing could be proven
  | 'ALIAS-IMP'; // the CSS import in the TS code is path-aliased — sheet not resolved

export type ClassVerdict =
  | { kind: 'safe' }
  | { kind: 'left'; code: LeftBehindCode; detail?: string; reason: string };

/** Long-form description per code — single source of truth for the report's prose. */
const VERDICT_REASONS: Record<LeftBehindCode, string> = {
  USED: 'still used by code remaining in the source file',
  'NO-RULE': 'no rule found for this class',
  COMPOUND: 'class appears in a compound selector elsewhere',
  NESTED: 'has nested rules',
  'NEST-PARENT': 'rule is nested inside another selector',
  'AT-RULE': 'uses an unsafe @-rule (mixin / function / import / etc)',
  'SASS-VAR': 'references a Sass variable',
  EXTEND: '@extend referenced from another rule',
  COMPOSES: 'composes another class, or is composed by another rule (CSS-modules linkage)',
  KEYFRAMES: 'animates a @keyframes defined in this sheet (scoped name would not travel)',
  'PARSE-FAIL': 'stylesheet could not be parsed / transformed',
  'ALIAS-IMP': 'aliased import — resolve manually',
};

/** At-rules whose presence in an owning rule's body makes the class unsafe to relocate —
 *  the styling they pull in (mixins, variables, conditionals) does not travel with the rule. */
const UNSAFE_AT_RULES = new Set([
  'include',
  'extend',
  'if',
  'for',
  'each',
  'while',
  'mixin',
  'function',
  'import',
  'use',
  'forward',
  'debug',
  'warn',
  'error',
]);

/** Classify each candidate class over the parsed sheet. `usedInRemaining` is the set of
 *  classes the post-extract source still references (or every class, when the remaining
 *  source used the import non-trivially — the §2.3 wildcard); those are always `USED`. */
export function classifyForExtract(
  root: Root,
  classNames: readonly string[],
  usedInRemaining: ReadonlySet<string>,
): Map<string, ClassVerdict> {
  const ctx = buildSheetContext(root);
  const out = new Map<string, ClassVerdict>();
  for (const cls of classNames)
    out.set(cls, classSafetyVerdict(root, cls, usedInRemaining.has(cls), ctx));
  return out;
}

/** Sheet-wide facts computed once: the locally-defined `@keyframes` names (scoped per sheet,
 *  so a moved rule animating one would dangle) and the classes referenced by some rule's
 *  `composes:` (CSS-modules linkage — moving such a class breaks the composition). */
interface SheetContext {
  keyframes: ReadonlySet<string>;
  composedClasses: ReadonlySet<string>;
}

function buildSheetContext(root: Root): SheetContext {
  const keyframes = new Set<string>();
  const composedClasses = new Set<string>();
  root.walkAtRules((at) => {
    if (/^(-\w+-)?keyframes$/.test(at.name)) keyframes.add(at.params.trim());
  });
  root.walkDecls('composes', (decl) => {
    for (const name of composesLocalTargets(decl.value)) composedClasses.add(name);
  });
  return { keyframes, composedClasses };
}

function classSafetyVerdict(
  root: Root,
  cls: string,
  usedInRemaining: boolean,
  ctx: SheetContext,
): ClassVerdict {
  if (usedInRemaining) return left('USED');

  const owning: Rule[] = [];
  let referencedElsewhere = false;
  let unsafe: ClassVerdict | undefined;

  root.walkRules((rule) => {
    if (unsafe !== undefined) return;
    if (selectorIsOwnedBy(rule.selector, cls)) {
      const parent = rule.parent;
      // An owning rule nested inside another selector can't be lifted to a flat sheet —
      // it depends on its ancestor's context.
      if (parent !== undefined && parent.type !== 'root') {
        unsafe = left('NEST-PARENT');
        return;
      }
      const bodyVerdict = inspectBody(rule, ctx);
      if (bodyVerdict !== undefined) {
        unsafe = bodyVerdict;
        return;
      }
      owning.push(rule);
    } else if (selectorReferences(rule.selector, cls)) {
      // The class is entangled with something else (descendant / compound / sibling).
      referencedElsewhere = true;
    }
  });

  if (unsafe !== undefined) return unsafe;
  // The class owns no top-level rule of its own. If it still APPEARS in some selector
  // (descendant / compound / comma group), it is entangled → COMPOUND (leave it behind), not
  // NO-RULE ("no such class"). Only a class that appears in no selector at all is NO-RULE.
  if (owning.length === 0) return left(referencedElsewhere ? 'COMPOUND' : 'NO-RULE');
  if (referencedElsewhere) return left('COMPOUND');
  if (isExtendedBy(root, cls)) return left('EXTEND');
  if (ctx.composedClasses.has(cls)) return left('COMPOSES'); // another rule composes this class
  return { kind: 'safe' };
}

/** Inspect an owning rule's body for the unsafe shapes. Walks the WHOLE subtree (not just
 *  direct children): an unsafe at-rule or nested rule buried inside a `@media`/`@supports`
 *  block is just as undeportable as a top-level one — its dependency (mixin/var/conditional, or
 *  an inner selector) does not travel with the moved rule. Returns the FIRST failure's verdict. */
function inspectBody(rule: Rule, ctx: SheetContext): ClassVerdict | undefined {
  let verdict: ClassVerdict | undefined;
  rule.walkAtRules((at) => {
    if (verdict === undefined && UNSAFE_AT_RULES.has(at.name)) {
      verdict = left('AT-RULE', `@${at.name}`, `uses @${at.name}`);
    }
  });
  if (verdict !== undefined) return verdict;
  rule.walkRules(() => {
    if (verdict === undefined) verdict = left('NESTED'); // any descendant rule
  });
  if (verdict !== undefined) return verdict;
  rule.walkDecls((decl) => {
    if (verdict !== undefined) return;
    // A Sass variable in a declaration's value OR its (interpolated) property name.
    if (/\$[A-Za-z_]/.test(decl.value) || /\$[A-Za-z_]/.test(decl.prop)) {
      verdict = left('SASS-VAR');
    } else if (decl.prop === 'composes') {
      // CSS-modules composition: the composed class (local or imported-by-relative-path) does
      // not travel with the moved rule.
      verdict = left('COMPOSES');
    } else if (/^(-\w+-)?animation(-name)?$/.test(decl.prop)) {
      // Animating a @keyframes defined in THIS sheet: the keyframe name is scoped per sheet, so
      // the moved rule's animation would reference a name that stayed behind.
      const names = decl.value.split(/[\s,]+/);
      if (names.some((n) => ctx.keyframes.has(n))) verdict = left('KEYFRAMES');
    }
  });
  return verdict;
}

/** Local `composes:` targets — the class names composed from THIS sheet. A `composes: x from
 *  '…'` pulls from another module (not a local class), so it contributes no local target. */
export function composesLocalTargets(value: string): string[] {
  if (/\bfrom\b/.test(value)) return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Class names targeted by one `@extend` — tolerant of `@extend .X !optional` and comma lists
 *  (`@extend .X, .Y`). Returns names WITHOUT the leading dot; a non-class target (e.g.
 *  `%placeholder`) is dropped. The single parser both `isExtendedBy` and find_unused share. */
export function parseExtendTargets(params: string): string[] {
  return params
    .replace(/!optional/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((t) => t.startsWith('.'))
    .map((t) => t.slice(1));
}

/** True when some rule `@extend`s `.cls` — a strict equality check would miss the optional /
 *  comma-list forms and wrongly move `.cls`. */
function isExtendedBy(root: Root, cls: string): boolean {
  let extended = false;
  root.walkAtRules('extend', (atrule) => {
    if (parseExtendTargets(atrule.params).includes(cls)) extended = true;
  });
  return extended;
}

/** "Owned" = the rule is dedicated to `cls` and ONLY `cls`. Allowed: `.X`, `.X:pseudo`,
 *  `.X::pseudo`, chained pseudos with non-selector args (`:nth-child(2n+1)`). NOT allowed:
 *  `.X.modifier` (compound), `.outer .X` (descendant), `.X.Y`, AND a pseudo whose arg holds a
 *  class/selector (`.X:not(.Y)`, `.X:has(.Z)`) — moving `.X` would carry a dependency on `.Y`,
 *  which stays behind under a different css-module hash (a silent type-blind break). A selector
 *  list `A, B, C` is owned only if EVERY branch is. */
export function selectorIsOwnedBy(selector: string, cls: string): boolean {
  const branches = selector.split(',').map((s) => s.trim());
  if (branches.length === 0) return false;
  // `[^).]` inside the pseudo-arg group rejects any `(... .cls ...)` — a class reference inside
  // `:not()`/`:has()`/`:is()` disqualifies ownership.
  const re = new RegExp(`^\\.${escapeRe(cls)}(:{1,2}[\\w-]+(\\([^).]*\\))?)*$`);
  return branches.every((branch) => re.test(branch));
}

/** Any appearance of `.cls` OUTSIDE an owning rule — the class is entangled with another
 *  selector (descendant, compound, sibling, or a mixed-owner selector list). */
function selectorReferences(selector: string, cls: string): boolean {
  if (selectorIsOwnedBy(selector, cls)) return false;
  return new RegExp(`\\.${escapeRe(cls)}([^\\w-]|$)`).test(selector);
}

function left(code: LeftBehindCode, detail?: string, reason?: string): ClassVerdict {
  return {
    kind: 'left',
    code,
    ...(detail !== undefined ? { detail } : {}),
    reason: reason ?? VERDICT_REASONS[code],
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
