// The CSS-module co-extract RULE TRANSFORM (spec-css-coextract §2.4 / §2.7) — pure: given a
// parsed sheet and the classes proven safe to move, produce (a) a fresh sheet holding only
// those owned rules (with their leading comment blocks) and (b) the source sheet with those
// rules removed. The op writes both strings through the plan; this stays side-effect-free.
//
// Only top-level rules OWNED by a safe class are touched — the classify pass (extract-classify)
// already rejected nesting / compounds / at-rules, so every rule reached here is a flat,
// self-contained block safe to relocate verbatim.

import postcss, { type Root, type Rule, type Comment } from 'postcss';
import postcssScss from 'postcss-scss';
import { selectorIsOwnedBy } from './extract-classify.ts';
import { isSassFile } from './parse-root.ts';

export type ExtractedRules = {
  /** Content of the new sheet beside the extracted file (safe rules + their comments). */
  newSheet: string;
  /** The source sheet with the moved rules (and their leading comments) removed. */
  sourceSheet: string;
};

export function extractRules(
  root: Root,
  safeClassNames: readonly string[],
  file: string,
): ExtractedRules {
  const safe = new Set(safeClassNames);
  const ownedByAnySafe = (rule: Rule): boolean => {
    for (const cls of safe) if (selectorIsOwnedBy(rule.selector, cls)) return true;
    return false;
  };
  const serialize = isSassFile(file)
    ? (node: Root): string => node.toString(postcssScss)
    : (node: Root): string => node.toString();

  // Build the new sheet in SOURCE ORDER (walkRules is document order). Each moved rule carries
  // its immediately-preceding comment siblings so a rule's docstring travels with it.
  const newRoot = postcss.parse('');
  root.walkRules((rule) => {
    if (!ownedByAnySafe(rule)) return;
    for (const comment of leadingComments(rule)) newRoot.append(comment.clone());
    newRoot.append(rule.clone());
  });

  // Remove the same rules (and their comments) from a CLONE of the source — the input root
  // is never mutated, so the op can still read it / re-run.
  const updatedRoot = root.clone();
  const toRemove: (Rule | Comment)[] = [];
  updatedRoot.walkRules((rule) => {
    if (!ownedByAnySafe(rule)) return;
    for (const comment of leadingComments(rule)) toRemove.push(comment);
    toRemove.push(rule);
  });
  for (const node of toRemove) node.remove();

  return { newSheet: serialize(newRoot), sourceSheet: serialize(updatedRoot) };
}

/** Walk back from a rule collecting the comment siblings that are its docstring — contiguous
 *  comments directly above it. STOP at a blank-line gap: a comment separated from the rule by a
 *  blank line is a file/section header, not this rule's doc, and must NOT be carried away (that
 *  would delete a license/header from the source sheet). postcss records the gap as the
 *  following node's `raws.before`. */
function leadingComments(rule: Rule): Comment[] {
  const out: Comment[] = [];
  let gapBefore = rule.raws.before ?? '';
  let prev = rule.prev();
  while (prev !== undefined && prev.type === 'comment') {
    if (hasBlankLine(gapBefore)) break;
    out.unshift(prev);
    gapBefore = prev.raws.before ?? '';
    prev = prev.prev();
  }
  return out;
}

/** True when whitespace contains a blank line (≥2 newlines) — the separator that detaches a
 *  comment from the rule below it. */
function hasBlankLine(ws: string): boolean {
  return /\n[ \t]*\n/.test(ws);
}
