// Shared helpers for the render-density guards (output-density*.test.ts). The dense text path is
// `condense → render-dense`; these are the structural oracles that detect a row that FAILED to
// collapse (a watery key=value explosion) or leaked its render-only `~shape` tag.

import { condenseSpans } from '../../src/format/render/condense.ts';
import { renderDense } from '../../src/format/render/render-dense.ts';
import { SHAPE_KEY } from '../../src/common/shape-tag/tag.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Verbosity } from '../../src/core/result.ts';

/** A span literal at a fixed file, for building sample rows. */
export const span = (line: number, text: string): JsonValue => ({
  file: 'src/h.ts',
  line,
  col: 1,
  endLine: line,
  endCol: 1 + text.length,
  text,
});

/** Render literal rows exactly as the text path does: condense then dense. */
export function renderRows(rows: JsonValue, verbosity: Verbosity = 'terse'): string {
  return renderDense(condenseSpans(rows, verbosity));
}

/** The array-item fall-through signature. render-dense's array-of-objects path emits `${pad}-
 *  ${firstField}` then the object's remaining fields at indent+2. The watery tell is a deeper
 *  SCALAR `key=value` line ANYWHERE in a `- ` bullet's block — that only happens when an object row
 *  failed to collapse and exploded into per-field lines. We scan the WHOLE block (a first-field-
 *  nested explosion pushes scalars to i+2+), matching scalar `key=value` ONLY (not a `key:` /
 *  `key (N):` header, nor a deeper `- ` bullet): a legitimately hierarchical row carries nested
 *  ARRAYS, never a bare scalar pair, and must NOT be flagged. */
export function fallThrough(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const bullet = /^(\s*)- /.exec(lines[i] ?? '');
    if (bullet === null) continue;
    const indent = bullet[1]?.length ?? 0;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '') break;
      const lead = (/^(\s*)/.exec(line)?.[1] ?? '').length;
      if (lead <= indent) break;
      if (/^\s+\w+=/.test(line)) return `${lines[i]}\n${line}`;
    }
  }
  return undefined;
}

/** Leaked-meta guard (verbosity-agnostic): every `~`-prefixed key is render-only META — the `~shape`
 *  tag a renderer CONSUMES, plus per-row render hints (`~subject`, `~sectioned`, …). The dispatcher
 *  strips them (renderer path discards `out`; full-passthrough deletes every `~`-key), so NONE may
 *  reach rendered text. render-dense emits a leaked key at a FIELD position — at line start (after
 *  indent, optionally a `- ` bullet) as `~word=value` (scalar), `~word:` (map), or `~word (N):`
 *  (array). Anchoring to that position is deliberate: it excludes a `~`-token that is part of a VALUE
 *  — the SymbolId `~rootTag` suffix (`…:2:14~18f5c50e (variable…`) and the CSS general-sibling
 *  combinator (`.a ~ .b`) — neither of which is a leaked key. */
const META_FIELD = /^\s*(?:- )?~\w+(?:=|:| \()/;

export function leakedTag(text: string): string | undefined {
  return text.split('\n').find((l) => META_FIELD.test(l) || l.includes(SHAPE_KEY));
}

/** Envelope MAPS that legitimately render as a `key:` header + scalar `k=v` children — NOT rows, so
 *  exempt from the top-level forgot-to-tag guard. MINIMAL + explicit (gardrail c). */
const ENVELOPE_MAPS = new Set([
  'scanned',
  'summary',
  'byDepth',
  'roleBreakdown',
  'typecheck',
  'rollback',
  'truncated',
  'partial',
]);

/** Forgot-to-tag guard for TOP-LEVEL nested objects: a `key:` header (not `key (N):`/`key=`) whose
 *  block holds a deeper scalar `k=v` is an un-collapsed single-object row that exploded — UNLESS the
 *  key is an allowlisted envelope map. Covers the `definition:` / `target:`-style rows the array-item
 *  `fallThrough` scan misses. */
export function topLevelExplosion(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([A-Za-z_][\w]*):$/.exec(lines[i] ?? '');
    if (m === null) continue;
    const key = m[2] ?? '';
    if (ENVELOPE_MAPS.has(key)) continue;
    const indent = (m[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '') break;
      const lead = (/^(\s*)/.exec(line)?.[1] ?? '').length;
      if (lead <= indent) break;
      if (/^\s+\w+=/.test(line)) return `${lines[i]}\n${line}`;
    }
  }
  return undefined;
}
