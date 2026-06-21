// Parse one locale JSON file into flattened dotted keys, each carrying a proof span at
// its property-name literal. The parser is the typescript package's `parseJsonText` —
// a position-carrying JSON AST (plain `JSON.parse` has no positions, and proof spans
// must point into the file at `file:line:col`, §3.2). `JSON.parse` is the malformed-file
// gate (its message is the human-readable one); a file that fails it surfaces in op
// results and demotes that file's claims to `partial`, never silently dropped (§3.6, the
// scss parse-failure precedent).
//
// A malformed file is NOT zeroed — `degrade-and-continue` over `zero-out`: we recover the
// keys of its WELL-FORMED PREFIX (every property whose name sits BEFORE the first parse
// error) and return them alongside the `ok:false` failure. Why a prefix and not the whole
// error-recovered tree: `parseJsonText` keeps parsing past the error, and a missing brace
// detected late re-nests later keys onto a path the file never had (`a.b` for a top-level
// `b`) — a mis-path is the §3.6 lie the strict gate guarded against. Cutting at the first
// error offset keeps only structure that parsed soundly; everything after is the untrusted
// region, dropped. The recovered keys still surface as `partial` (the file stays in the
// plugin's `failures` set → its claims demote), so the recovery is honest, never `certain`.
// The boundary offset is the EARLIEST of `parseJsonText`'s parse diagnostics and the
// `JSON.parse` error position — both are consulted because a trailing comma (the commonest
// malformation) yields NO TS diagnostic, only a `JSON.parse` position.
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

export type LocaleParseOutcome =
  // `keys` carries the well-formed-prefix recovery on the failure branch too (degrade-and-
  // continue, §3.6) — empty only when the error sits before the first key or no boundary is
  // locatable. `message` is the human-readable `JSON.parse` reason.
  { ok: true; keys: LocaleKey[] } | { ok: false; message: string; keys: LocaleKey[] };

export function parseLocaleKeys(rel: RepoRelPath, source: string): LocaleParseOutcome {
  // `JSON.parse` is the malformed-file gate (its message is the human-readable one) and, on
  // failure, also gives the error position — the prefix boundary when TS emits no diagnostic.
  let message: string | undefined;
  let jsonPos = -1;
  try {
    JSON.parse(source);
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
    const m = /position (\d+)/.exec(message);
    if (m?.[1] !== undefined) jsonPos = Number(m[1]);
  }

  // Recovery is wrapped: a `parseJsonText` / walk failure must never crash the plugin — it
  // degrades to an empty key set with the (already-captured) error reported (§ never-crash).
  let keys: LocaleKey[] = [];
  try {
    const sf = ts.parseJsonText(rel, source);
    const root = sf.statements[0]?.expression;
    if (root !== undefined && ts.isObjectLiteralExpression(root)) {
      // Well-formed → take every key (boundary = ∞). Malformed → cut at the first error
      // offset; an unlocatable boundary (-1) recovers nothing (the safe side).
      const boundary = message === undefined ? Infinity : firstErrorOffset(sf, jsonPos);
      collect(root, '', sf, rel, keys, boundary);
    }
  } catch (thrown) {
    if (message === undefined) message = thrown instanceof Error ? thrown.message : String(thrown);
    keys = [];
  }

  return message === undefined ? { ok: true, keys } : { ok: false, message, keys };
}

/** The earliest offset at which the file stops being well-formed: the min of `parseJsonText`'s
 *  parse-diagnostic positions and the `JSON.parse` error position (`-1` when absent). `-1` when
 *  neither locates an error → the caller recovers nothing rather than trust a re-nested tree. */
function firstErrorOffset(sf: ts.JsonSourceFile, jsonPos: number): number {
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  const offsets: number[] = jsonPos >= 0 ? [jsonPos] : [];
  for (const d of diags ?? []) if (typeof d.start === 'number') offsets.push(d.start);
  return offsets.length > 0 ? Math.min(...offsets) : -1;
}

function collect(
  obj: ts.ObjectLiteralExpression,
  prefix: string,
  sf: ts.JsonSourceFile,
  rel: RepoRelPath,
  out: LocaleKey[],
  boundary: number,
): void {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.name)) continue;
    // A property whose name starts at/after the first error is past the well-formed prefix —
    // its path may be a mis-nested artifact of error recovery, so it is dropped, not recovered.
    if (prop.name.getStart(sf) >= boundary) continue;
    const dotted = prefix === '' ? prop.name.text : `${prefix}.${prop.name.text}`;
    const init = prop.initializer;
    if (ts.isObjectLiteralExpression(init)) {
      collect(init, dotted, sf, rel, out, boundary);
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
