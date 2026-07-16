// Renderer for the `source` op (§3.2). Unlike the generic dense path, `source` ALWAYS
// shows bodies (that is the whole point — "show me the code"), so it must NOT flow
// through verbosity-driven span condensation, which would collapse every body to a
// `file:line` at terse. Instead it renders bodies until an overall char budget is hit,
// then collapses the remaining targets to a header line — explicitly counted, never a
// silent cut (§3.4 / §12 "size to the answer").

import type { JsonValue } from '../../core/json.ts';
import { elideString } from '../../common/truncate/elide-string.ts';

/** Body-text budget across all targets. Below the renderer's `RENDER_CHAR_CAP` so the
 *  graceful "… source elided for K" collapse happens before the blunt output cap. */
const SOURCE_BODY_BUDGET = 12_000;

export type SourceSpan = {
  file: string;
  line: number;
  col: number;
  text: string;
  elided?: boolean;
};
export type SourceEntry = {
  id: string;
  name: string;
  kind: string;
  decl: SourceSpan;
  rebound?: { from: string; to: string; confidence: string };
  moreDefinitions?: string[];
};
type Unresolved = { target: string; reason: string };

/** Shape guard for `source` op data: an object carrying a `sources` array. Distinct from
 *  find_usages multi-target (`targets`) and the sql table (`columns`/`rows`). */
export function isSourceData(data: JsonValue): data is {
  sources: SourceEntry[];
  unresolved?: Unresolved[];
} {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Array.isArray((data as { sources?: unknown }).sources)
  );
}

export function renderSource(
  data: { sources: SourceEntry[]; unresolved?: Unresolved[] },
  budget: number = SOURCE_BODY_BUDGET,
): string {
  const lines: string[] = [];
  let used = 0;
  let elided = 0;
  data.sources.forEach((s, i) => {
    // The id already encodes the file (`name@file:line:col`); the decl span's line:col is the
    // DECLARATION START (distinct from the id's name-token col), so keep just `:line:col` and drop
    // the repeated file (§12 density). Leading `:` signals "same file as the id".
    const header = `${s.id} · ${s.kind} @ :${s.decl.line}:${s.decl.col}`;
    // Always show the FIRST body (the explore-one-big-thing case must not collapse to a
    // header). After that, render bodies until the budget is spent; then every remaining
    // target collapses to a header line so a big body can't starve which symbols followed.
    if (elided === 0 && (i === 0 || used + s.decl.text.length <= budget)) {
      lines.push(header, ...meta(s), s.decl.text);
      // §3.4: a body cut at the per-span cap must say so, not trail off into a silent `…`.
      if (s.decl.elided === true) {
        lines.push('[body truncated at span cap — re-request individually or Read the file]');
      }
      used += s.decl.text.length;
    } else {
      elided++;
      lines.push(`${header} · ${firstLine(s.decl.text)}`, ...meta(s));
    }
  });
  if (elided > 0) {
    lines.push(`… source elided for ${elided} target(s) (re-request individually)`);
  }
  for (const u of data.unresolved ?? []) {
    lines.push(`unresolved: ${u.target} — ${u.reason}`);
  }
  return lines.join('\n');
}

/** Per-target honesty lines that apply in both the full and collapsed branches: a stated
 *  rebind (§6) and a "more definitions exist" note (§3.4). */
function meta(s: SourceEntry): string[] {
  const out: string[] = [];
  if (s.rebound !== undefined) {
    out.push(
      `↻ rebound from ${s.rebound.from} (confidence=${s.rebound.confidence}) — held handle moved`,
    );
  }
  if (s.moreDefinitions !== undefined && s.moreDefinitions.length > 0) {
    out.push(`… ${s.moreDefinitions.length} more definition(s) at ${s.moreDefinitions.join(', ')}`);
  }
  return out;
}

function firstLine(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return elideString(first, 80).text;
}
