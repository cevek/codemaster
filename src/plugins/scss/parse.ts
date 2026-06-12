// Parse one SCSS file into class declarations via postcss-scss — a CST, syntactic
// only (§19): nesting is resolved for plain `&`-composition, but cross-`@use` /
// `@forward` visibility and computed selectors are beyond this parse and must be
// reported `partial` by consumers, never guessed.

import postcssScss from 'postcss-scss';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';

export type ScssClass = {
  /** Class name without the leading dot. */
  name: string;
  span: Span;
  /** True when the name came from a selector we could only partially resolve
   *  (interpolation, parent-composition we don't expand). */
  partial: boolean;
};

export type ScssParseOutcome = { ok: true; classes: ScssClass[] } | { ok: false; message: string };

const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/g;

export function parseScssClasses(rel: RepoRelPath, source: string): ScssParseOutcome {
  let root;
  try {
    root = postcssScss.parse(source, { from: rel });
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  const classes: ScssClass[] = [];
  root.walkRules((rule) => {
    const start = rule.source?.start;
    if (start === undefined) return;
    const selector = rule.selector;
    const hasInterpolation = selector.includes('#{');
    for (const match of selector.matchAll(CLASS_TOKEN)) {
      const name = match[1];
      if (name === undefined) continue;
      const before = selector.slice(0, match.index);
      const lineOffset = countLines(before);
      const colBase = lineOffset === 0 ? start.column + (match.index ?? 0) : colInLastLine(before);
      classes.push({
        name,
        span: {
          file: rel,
          line: start.line + lineOffset,
          col: colBase,
          endLine: start.line + lineOffset,
          endCol: colBase + name.length + 1,
          text: `.${name}`,
        },
        partial: hasInterpolation,
      });
    }
  });
  return { ok: true, classes };
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function colInLastLine(text: string): number {
  const idx = text.lastIndexOf('\n');
  return text.length - idx; // 1-based column within that line
}
