// Extract the resolved CASCADE CONTRIBUTIONS for a target class from one stylesheet's
// postcss CST (spec-css-cascade-op). A contribution is one resolved selector BRANCH whose
// subject (rightmost compound) targets the class, paired with the declarations the branch
// sets. Nesting/`&` is expanded here (specificity.ts only sees flat resolved selectors);
// a shape we cannot resolve is reported `partial`/skipped, never a fabricated selector (§3).
//
// This is cascade's OWN inclusion policy — deliberately NOT parse.ts's class-declaration
// machinery, which drops/down-ranks exactly the descendant/`:global`/compound selectors a
// cross-module override hides in.

import type { AtRule, Container, Declaration, Document, Root, Rule } from 'postcss';
import type { RepoRelPath } from '../../../core/brands.ts';
import type { Span } from '../../../core/span.ts';
import { computeLineStarts, locToOffset, offsetToLoc } from '../../../common/span/offset.ts';
import {
  analyzeBranch,
  splitSelectorList,
  type ConditionReason,
  type Specificity,
} from './specificity.ts';

/** One declaration inside a contributing rule, proof-carrying. `computed` flags a value
 *  the syntactic model can't evaluate (a Sass `$var` / `#{…}`) — reported verbatim, never
 *  guessed (§19). */
export type CascadeDecl = {
  prop: string;
  value: string;
  important: boolean;
  computed: boolean;
  span: Span;
  /** Source character offset — the document-order key the resolver uses to break a
   *  same-specificity tie WITHIN one file (the later declaration wins). */
  pos: number;
};

/** One resolved selector branch that targets the class, with the declarations it sets. */
export type CascadeContribution = {
  file: RepoRelPath;
  /** The resolved effective selector branch (nesting/`&` expanded) — our derivation. */
  selector: string;
  specificity: Specificity;
  /** Subject conditions (descendant context / state pseudo / attribute / …) — each makes
   *  the match less than unconditional, so the resolver demotes it to `partial`. */
  conditions: ConditionReason[];
  /** Enclosing `@media`/`@supports`/`@container` preludes (outermost→inner) — the branch
   *  applies only in that context. */
  atContext: string[];
  /** The selector used interpolation (`#{…}`) — specificity is a lower bound. */
  interpolated: boolean;
  /** The class was reached through a `:global(…)` (not module-scoped) — always uncertain. */
  global: boolean;
  /** Subject classes OTHER than the target — the element must ALSO carry these to match. */
  requiresExtraClasses: string[];
  /** Proof span over the selector AS WRITTEN in source (the resolved string is derived). */
  selectorSpan: Span;
  declarations: CascadeDecl[];
};

const AT_CONTEXT = /^(media|supports|container)$/i;

export function extractContributions(
  root: Root,
  rel: RepoRelPath,
  source: string,
  target: string,
): CascadeContribution[] {
  const lineStarts = computeLineStarts(source);
  const out: CascadeContribution[] = [];
  root.walkRules((rule) => {
    const selectorSpan = selectorSpanOf(rule, rel, source, lineStarts);
    if (selectorSpan === undefined) return; // can't prove location → don't emit (§3.2)
    const decls = directDeclarations(rule, rel, source, lineStarts);
    if (decls.length === 0) return; // a bare nesting container sets nothing here
    const atContext = atContextOf(rule);
    for (const branch of resolvedBranches(rule)) {
      const { specificity, traits } = analyzeBranch(branch);
      const match = matchTarget(branch, target, traits.subjectClasses);
      if (match === undefined) continue;
      out.push({
        file: rel,
        selector: branch,
        specificity,
        conditions: traits.conditions,
        atContext,
        interpolated: traits.interpolated,
        global: match.global,
        requiresExtraClasses: match.subject.filter((c) => c !== target),
        selectorSpan,
        declarations: decls,
      });
    }
  });
  return out;
}

/** Does this resolved branch's subject target the class? Returns the matched subject class
 *  set and whether the match was through a `:global(…)` (or bare `:global` block). */
function matchTarget(
  branch: string,
  target: string,
  subjectClasses: string[],
): { subject: string[]; global: boolean } | undefined {
  const hasGlobal = /:global(?![\w-])/.test(branch);
  const bareGlobal = hasGlobal && !/:global\s*\(/.test(branch);
  // Bare `:global { … }` / `:global .x` scopes its classes OUT of module space, so the
  // subject classes analyzeBranch read are actually global; the paren form `:global(.x)`
  // hides its classes inside the pseudo arg, so pull them out explicitly.
  const moduleSubject = bareGlobal ? [] : subjectClasses;
  const globalSubject = [...globalParenClasses(branch), ...(bareGlobal ? subjectClasses : [])];
  if (moduleSubject.includes(target)) return { subject: moduleSubject, global: false };
  if (globalSubject.includes(target)) return { subject: globalSubject, global: true };
  return undefined;
}

/** Class names inside `:global(…)` groups. */
function globalParenClasses(selector: string): string[] {
  const out: string[] = [];
  const re = /:global\s*\(([^)]*)\)/g;
  for (let m = re.exec(selector); m !== null; m = re.exec(selector)) {
    for (const cls of m[1]?.match(/\.-?[_a-zA-Z][\w-]*/g) ?? []) out.push(cls.slice(1));
  }
  return out;
}

/** Hard cap on the resolved-branch cross-product per rule (§1 never-hang): deeply nested
 *  comma lists blow up as kᵈᵉᵖᵗʰ, so beyond this we STOP and throw a bounded error (the caller
 *  records it as a per-sheet failure — honest, never a silent truncation nor a spin). */
const MAX_BRANCHES = 512;
/** Per-parse memo so the ancestor chain isn't re-resolved for every visited rule (O(depth²)→
 *  O(depth)). Keyed by the postcss `Rule`; entries GC with the tree between calls. */
const branchMemo = new WeakMap<Rule, string[]>();

/** The resolved selector branches of `rule`, expanding SCSS nesting/`&`. A rule at the root
 *  is its own selector list; a nested rule is each parent branch × each own branch combined. */
function resolvedBranches(rule: Rule): string[] {
  const cached = branchMemo.get(rule);
  if (cached !== undefined) return cached;
  const own = splitSelectorList(rule.selector);
  const parents = parentSelectorBranches(rule);
  let result: string[];
  if (parents === undefined) {
    result = own.length > 0 ? own : [rule.selector.trim()];
  } else {
    if (parents.length * own.length > MAX_BRANCHES) {
      throw new Error(
        `cascade nesting expansion exceeded ${MAX_BRANCHES} resolved branches (deeply nested comma lists) — scope with pathInclude`,
      );
    }
    result = [];
    for (const parent of parents)
      for (const child of own) result.push(combineNesting(parent, child));
  }
  branchMemo.set(rule, result);
  return result;
}

/** The resolved branches of the nearest ANCESTOR rule (skipping `@media`/at-rule wrappers,
 *  which don't change the selector), or `undefined` when the rule is effectively top-level. */
function parentSelectorBranches(rule: Rule): string[] | undefined {
  let node: Container | Document | undefined = rule.parent;
  while (node !== undefined && node.type === 'atrule') node = node.parent;
  if (node === undefined || node.type === 'root') return undefined;
  return resolvedBranches(node as Rule);
}

/** Combine a parent branch with a nested child branch. `&` (any position) substitutes the
 *  parent text literally (`&__el` → `block__el`, `.x &` → `.x .block`); otherwise the child
 *  is a descendant (`parent child`). A FUNCTION replacer is used so a `$&`/`$'` in the parent
 *  text is inserted literally, never interpreted as a replacement pattern (a fabricated
 *  selector would be the §3 lie). */
function combineNesting(parent: string, child: string): string {
  if (child.includes('&')) return child.replace(/&/g, () => parent);
  return `${parent} ${child}`;
}

/** Enclosing conditional at-rules, outermost→inner — the branch applies only in this context. */
function atContextOf(rule: Rule): string[] {
  const ctx: string[] = [];
  let node: Container | Document | undefined = rule.parent;
  while (node !== undefined) {
    if (node.type === 'atrule') {
      const at = node as AtRule;
      if (AT_CONTEXT.test(at.name)) ctx.unshift(`@${at.name} ${at.params}`.trim());
    }
    node = node.parent;
  }
  return ctx;
}

/** Direct declaration children of the rule (NOT a nested rule's — those are their own
 *  contributions). Each carries a proof span over the `prop: value` source. */
function directDeclarations(
  rule: Rule,
  rel: RepoRelPath,
  source: string,
  lineStarts: readonly number[],
): CascadeDecl[] {
  const out: CascadeDecl[] = [];
  for (const node of rule.nodes ?? []) {
    if (node.type !== 'decl') continue;
    const decl = node as Declaration;
    const span = nodeSpanOf(decl, rel, source, lineStarts);
    if (span === undefined) continue;
    const start = decl.source?.start;
    const pos =
      start === undefined
        ? 0
        : (locToOffset(lineStarts, source.length, start.line, start.column) ?? 0);
    out.push({
      prop: decl.prop,
      value: decl.value,
      important: decl.important === true,
      // A Sass variable token starts with a letter/underscore (`$brand`), never a digit — so
      // `$5.00` / `url(a$b)` literals are NOT flagged computed (which would needlessly demote a
      // statically-valued winner to partial). Interpolation `#{…}` is always computed.
      computed: /\$[A-Za-z_]/.test(decl.value) || decl.value.includes('#{'),
      span,
      pos,
    });
  }
  return out;
}

/** Offset of the `{` that opens the rule body, starting from the selector start. Skips
 *  strings, `/* … *\/` comments, `[…]` attribute values, and SCSS `#{…}` interpolation, so a
 *  `{` inside any of those (`.a[x="{"]`, `.foo#{$x}`, `.foo /* { *\/`) never truncates the
 *  selector proof span at the wrong place (a wrong/incomplete proof is the §16-inv.1 lie).
 *  Returns -1 if no body brace is found. */
function ruleBraceOffset(source: string, from: number): number {
  let i = from;
  let quote = '';
  while (i < source.length) {
    const c = source[i];
    if (quote !== '') {
      if (c === '\\') i += 2;
      else {
        if (c === quote) quote = '';
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '[') {
      i = closeAttr(source, i) + 1;
    } else if (c === '#' && source[i + 1] === '{') {
      i = closeInterpolation(source, i + 1) + 1;
    } else if (c === '{') {
      return i;
    } else i++;
  }
  return -1;
}

/** Index of the `]` closing the `[` at `open`, quote-aware; the string end if unbalanced. */
function closeAttr(s: string, open: number): number {
  let quote = '';
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (quote !== '') {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ']') return i;
  }
  return s.length - 1;
}

/** Index of the `}` closing the interpolation whose `{` is at `open`, honouring nesting. */
function closeInterpolation(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length - 1;
}

/** Proof span over a rule's selector AS WRITTEN (start of the rule to just before `{`). */
function selectorSpanOf(
  rule: Rule,
  rel: RepoRelPath,
  source: string,
  lineStarts: readonly number[],
): Span | undefined {
  const start = rule.source?.start;
  if (start === undefined) return undefined;
  const startOffset = locToOffset(lineStarts, source.length, start.line, start.column);
  if (startOffset === undefined) return undefined;
  const brace = ruleBraceOffset(source, startOffset);
  if (brace === -1) return undefined;
  const raw = source.slice(startOffset, brace).replace(/\s+$/, '');
  const endOffset = startOffset + raw.length;
  const endLoc = offsetToLoc(lineStarts, source.length, endOffset);
  if (endLoc === undefined) return undefined;
  return {
    file: rel,
    line: start.line,
    col: start.column,
    endLine: endLoc.line,
    endCol: endLoc.col,
    text: source.slice(startOffset, endOffset),
  };
}

/** Proof span over a postcss node from its source start/end (end column is inclusive in
 *  postcss → +1 for the exclusive convention). Returns undefined when the node carries no
 *  position or the slice doesn't fit (never a fabricated span, §16 inv.1). */
function nodeSpanOf(
  node: Declaration,
  rel: RepoRelPath,
  source: string,
  lineStarts: readonly number[],
): Span | undefined {
  const start = node.source?.start;
  const end = node.source?.end;
  if (start === undefined || end === undefined) return undefined;
  const startOffset = locToOffset(lineStarts, source.length, start.line, start.column);
  const endOffset = locToOffset(lineStarts, source.length, end.line, end.column + 1);
  if (startOffset === undefined || endOffset === undefined || endOffset < startOffset) {
    return undefined;
  }
  return {
    file: rel,
    line: start.line,
    col: start.column,
    endLine: end.line,
    endCol: end.column + 1,
    text: source.slice(startOffset, endOffset),
  };
}
