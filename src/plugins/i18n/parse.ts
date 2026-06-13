// Parse one locale JSON file into flattened dotted keys, each carrying a proof span at
// its property-name literal. The parser is the typescript package's `parseJsonText` —
// a position-carrying JSON AST (plain `JSON.parse` has no positions, and proof spans
// must point into the file at `file:line:col`, §3.2). `JSON.parse` is the malformed-file
// gate (its message is the human-readable one); a file that fails it surfaces in op
// results and demotes that file's claims to `partial`, never silently dropped (§3.6, the
// scss parse-failure precedent).
//
// Spans are built HERE (the i18n plugin owns its parser, §4) — never imported from the
// ts plugin — with the 0-based→1-based `+1` on both line and col (the §16 invariant-1
// hotspot).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';

export type LocaleKey = {
  /** Dotted path, e.g. `a.b.c`. */
  key: string;
  /** String leaves carry their text; non-string leaves (arrays, numbers) a compact
   *  rendering — values are opaque text here (no ICU/plural semantics, §non-goals). */
  value: string;
  /** Proof span over the property-name literal (quotes included). */
  span: Span;
};

export type LocaleParseOutcome = { ok: true; keys: LocaleKey[] } | { ok: false; message: string };

export function parseLocaleKeys(rel: RepoRelPath, source: string): LocaleParseOutcome {
  // The honesty gate: strict JSON only. A malformed locale file is reported, never
  // half-read (parseJsonText would best-effort a broken tree).
  try {
    JSON.parse(source);
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  const sf = ts.parseJsonText(rel, source);
  const root = sf.statements[0]?.expression;
  const keys: LocaleKey[] = [];
  if (root !== undefined && ts.isObjectLiteralExpression(root)) {
    collect(root, '', sf, rel, keys);
  }
  return { ok: true, keys };
}

function collect(
  obj: ts.ObjectLiteralExpression,
  prefix: string,
  sf: ts.JsonSourceFile,
  rel: RepoRelPath,
  out: LocaleKey[],
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.name)) continue;
    const dotted = prefix === '' ? prop.name.text : `${prefix}.${prop.name.text}`;
    const init = prop.initializer;
    if (ts.isObjectLiteralExpression(init)) {
      collect(init, dotted, sf, rel, out);
    } else {
      out.push({ key: dotted, value: renderValue(init, sf), span: spanOfNode(prop.name, sf, rel) });
    }
  }
}

function renderValue(node: ts.Expression, sf: ts.JsonSourceFile): string {
  if (ts.isStringLiteral(node)) return node.text;
  return node.getText(sf).replace(/\s+/g, ' ').trim();
}

function spanOfNode(node: ts.Node, sf: ts.JsonSourceFile, rel: RepoRelPath): Span {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const s = sf.getLineAndCharacterOfPosition(start);
  const e = sf.getLineAndCharacterOfPosition(end);
  return {
    file: rel,
    line: s.line + 1,
    col: s.character + 1,
    endLine: e.line + 1,
    endCol: e.character + 1,
    text: sf.text.slice(start, end),
  };
}
