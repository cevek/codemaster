// Parse a string an agent passed where a structured target was expected (§7 Postel) — the
// `name: "ts:…"` / `name: "path:line:col"` shapes from the dogfood fail log, and the bare
// string ELEMENTS of `source.targets` (`["src/x.ts:12:3"]`). Pure: classifies the string,
// never invents a missing column (a `path:line` with no col stays col-less, so the canonical
// gate honestly asks for the column rather than guessing one — §3, Postel "form only").

/** A target string classified into the canonical shape it denotes. `location` keeps `col`
 *  optional precisely because a `path:line` (no column) must NOT be fabricated a column —
 *  it flows on as `{file,line}` and the canonical `requireTarget` rejects it with a pointed
 *  "needs file+line+col", never a wrong guess. */
export type TargetString =
  | { kind: 'symbolId'; symbolId: string }
  | { kind: 'location'; file: string; line: number; col?: number }
  | { kind: 'name'; name: string };

/** Does the prefix look like a file path (so `prefix:line:col` is a position, not a name with
 *  incidental colons)? A path has a `/` separator or a trailing file extension. */
function looksLikePath(prefix: string): boolean {
  return prefix.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(prefix);
}

export function classifyTargetString(s: string): TargetString {
  // A `ts:` SymbolId always carries the `@file` separator (`ts:Name@path:line:col`).
  if (s.startsWith('ts:') && s.includes('@')) return { kind: 'symbolId', symbolId: s };
  const withCol = /^(.+):(\d+):(\d+)$/.exec(s);
  if (withCol !== null && looksLikePath(withCol[1] ?? '')) {
    return {
      kind: 'location',
      file: withCol[1] ?? '',
      line: Number(withCol[2]),
      col: Number(withCol[3]),
    };
  }
  const noCol = /^(.+):(\d+)$/.exec(s);
  if (noCol !== null && looksLikePath(noCol[1] ?? '')) {
    return { kind: 'location', file: noCol[1] ?? '', line: Number(noCol[2]) };
  }
  return { kind: 'name', name: s };
}

/** The canonical target fields a classified string denotes (for an element object / args merge). */
export function targetFields(t: TargetString): Record<string, string | number> {
  switch (t.kind) {
    case 'symbolId':
      return { symbolId: t.symbolId };
    case 'location':
      return t.col !== undefined
        ? { file: t.file, line: t.line, col: t.col }
        : { file: t.file, line: t.line };
    case 'name':
      return { name: t.name };
  }
}

/** The intake-note label for a `name`-string rewrite (`undefined` when the string is a plain
 *  name — nothing was rewritten). */
export function targetRewriteLabel(t: TargetString): string | undefined {
  switch (t.kind) {
    case 'symbolId':
      return 'name→symbolId';
    case 'location':
      return t.col !== undefined ? 'name→file:line:col' : 'name→file:line';
    case 'name':
      return undefined;
  }
}
