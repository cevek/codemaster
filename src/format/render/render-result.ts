// Render a `Result<JsonValue>` envelope as dense agent-facing text (§12). Every
// honesty channel of the envelope surfaces explicitly: failure (with the tool named),
// partiality, freshness drift, handle rebinds, truncation. Nothing is dropped to make
// the output prettier — omitting a FreshnessNote is the silent-stale lie.

import type { Result, FreshnessNote, Truncation, Verbosity } from '../../core/result.ts';
import type { HandleRebind } from '../../core/ids.ts';
import type { JsonValue } from '../../core/json.ts';
import { renderDense } from './render-dense.ts';
import { condenseSpans } from './condense.ts';
import { isSqlTableData, renderSqlTable } from './render-table.ts';

/** Hard self-cap on one rendered result. Blowing the agent's context with a dump is a
 *  failure mode of its own — past the cap the output is cut AT A LINE BOUNDARY with an
 *  explicit marker telling how much was cut and how to narrow. Never a silent cut, and
 *  never a 95KB "answer". */
const RENDER_CHAR_CAP = 20_000;

/** Default verbosity is TERSE: list-shaped answers come back as `file:line:col` lines;
 *  verbatim proof text is opt-in via verbosity=full (re-fetch one symbol when needed). */
export function renderResult(result: Result<JsonValue>, verbosity: Verbosity = 'terse'): string {
  const lines: string[] = [];

  if (!result.ok) {
    const partial = result.failure.partial === true;
    lines.push(
      `FAIL tool=${result.failure.tool}${partial ? ' partial=true' : ''} — ${result.failure.message}`,
    );
    if (partial && result.data !== undefined) {
      lines.push(`data (incomplete — produced before the failure):`);
      lines.push(renderDense(condenseSpans(result.data, verbosity)));
    }
  } else if (isSqlTableData(result.data)) {
    // sql-mode result (§5.6): a relation, not a span tree — its own dense table.
    lines.push(renderSqlTable(result.data));
    if (result.truncated !== undefined) lines.push(renderTruncation(result.truncated));
  } else {
    lines.push(renderDense(condenseSpans(result.data, verbosity)));
    if (result.truncated !== undefined) lines.push(renderTruncation(result.truncated));
  }

  if (result.handle !== undefined) lines.push(renderRebind(result.handle));
  if (result.freshness !== undefined) {
    const freshness = renderFreshness(result.freshness, verbosity);
    if (freshness !== undefined) lines.push(freshness);
  }
  if (result.debug !== undefined && result.debug.length > 0) {
    lines.push('--- debug trace ---', ...result.debug, '--- end debug ---');
  }
  return capOutput(lines.join('\n'));
}

function capOutput(rendered: string): string {
  if (rendered.length <= RENDER_CHAR_CAP) return rendered;
  const cut = rendered.lastIndexOf('\n', RENDER_CHAR_CAP);
  const head = rendered.slice(0, cut > 0 ? cut : RENDER_CHAR_CAP);
  return `${head}\n!! OUTPUT CAPPED: ${rendered.length} chars total, showing first ${head.length}. Narrow the query (lower limit, scope by file/dir) or use fields/terse — do NOT assume this is everything.`;
}

function renderTruncation(t: Truncation): string {
  return `… ${t.total - t.shown} more (shown ${t.shown}/${t.total}; ${t.hint})`;
}

function renderRebind(rebind: HandleRebind): string {
  switch (rebind.status) {
    case 'rebound': {
      const proof = `${rebind.proof.file}:${rebind.proof.line}`;
      const note = rebind.note === undefined ? '' : ` note=${JSON.stringify(rebind.note)}`;
      return `handle: rebound ${rebind.from} -> ${rebind.to.id} (${rebind.to.kind} @ ${proof}, confidence=${rebind.confidence})${note}`;
    }
    case 'gone':
      return `handle: gone ${rebind.from} — ${rebind.reason}`;
  }
}

function renderFreshness(note: FreshnessNote, verbosity: Verbosity): string | undefined {
  // A reindex-at-entry is reported at EVERY verbosity including terse (§1.3): a
  // drift-triggered reindex that produced a silent, otherwise-fresh answer left a field
  // agent having to *trust* their edit was picked up. The commit anchor is optional — a
  // mutated tree is dirty, so there is no clean commit to name.
  const reindexed = note.reindexed ?? 0;
  if (reindexed > 0) {
    const at = note.indexedAtCommit === undefined ? '' : ` @${note.indexedAtCommit.slice(0, 9)}`;
    const head = `freshness: reindexed ${reindexed} file(s) at entry${at}`;
    if (note.pending === 0) return head;
    // Reindexed some, but others remain pending (a reindex that didn't fully catch up).
    return `${head}; PENDING ${note.pending} file(s) not yet reindexed`;
  }
  if (note.pending === 0) {
    // Fully fresh: only worth a line outside terse mode, and only the commit anchor.
    if (verbosity === 'terse' || note.indexedAtCommit === undefined) return undefined;
    return `freshness: current @${note.indexedAtCommit.slice(0, 9)}`;
  }
  const parts = [`freshness: PENDING ${note.pending} file(s) not yet reindexed`];
  if (note.staleFiles !== undefined && note.staleFiles.length > 0) {
    const shown = note.staleFiles.slice(0, 10);
    const more = note.staleFiles.length - shown.length;
    parts.push(`stale=[${shown.join(',')}${more > 0 ? ` …+${more}` : ''}]`);
  }
  if (verbosity === 'full') {
    parts.push(`plugins=[${note.plugins.map((p) => `${p.id}:${p.fingerprint}`).join(' ')}]`);
  }
  return parts.join(' ');
}
