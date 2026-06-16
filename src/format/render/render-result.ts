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
import { isSourceData, renderSource, type SourceEntry, type SourceSpan } from './render-source.ts';

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
    // The affordance at the moment of pain (spec-feedback-channel §3): only on a hard
    // FAIL, never on `partial` (which is honest success). The nudge fires where the agent
    // is blocked, not in a doc read once.
    if (!partial) {
      lines.push(
        "— blocked or missing a capability? file it: op({name:'feedback', args:{kind:'bug', title:'…', detail:'…'}})",
      );
    }
  } else if (isSqlTableData(result.data)) {
    // sql-mode result (§5.6): a relation, not a span tree — its own dense table.
    lines.push(renderSqlTable(result.data));
    if (result.truncated !== undefined) lines.push(renderTruncation(result.truncated));
  } else if (isSourceData(result.data)) {
    // `source` op (§3.2): always show bodies (never condensed to loc), budget + elision.
    lines.push(renderSource(result.data));
    if (result.truncated !== undefined) lines.push(renderTruncation(result.truncated));
  } else if (verbosity === 'full' && isDefinitionsData(result.data)) {
    // find_definition at full carries the same {id,name,kind,decl(body)} as `source`, just
    // under `definitions` — render it through source's compact body path (header + raw body)
    // instead of exploding each Span into file=/line=/col=/endLine= lines. The redundant
    // name-token `span` and the `container` fall away (the id already encodes both).
    const src = definitionsToSourceData(result.data.definitions);
    const usable =
      result.data.definitions.length > 0 &&
      src.sources.length === result.data.definitions.length &&
      src.sources.every((s) => s.decl.text.length > 0);
    // Empty, OR no usable body on some definition → dense path: never a blank render, never a
    // silently dropped definition (the dense fallback shows `definitions (N):` + every span).
    lines.push(usable ? renderSource(src) : renderDense(condenseSpans(result.data, verbosity)));
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
  return `${head}\n!! OUTPUT CAPPED: ${rendered.length} chars total, showing first ${head.length}. Narrow the query (lower limit, scope by file/dir), use terse, or project columns with sql — do NOT assume this is everything.`;
}

function renderTruncation(t: Truncation): string {
  return `… ${t.total - t.shown} more (shown ${t.shown}/${t.total}; ${t.hint})`;
}

/** find_definition's envelope: `{ definitions: SymbolView[] }`. */
function isDefinitionsData(data: JsonValue): data is { definitions: JsonValue[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Array.isArray((data as { definitions?: unknown }).definitions)
  );
}

/** Project SymbolView definitions onto the `source` op's shape (reusing its canonical
 *  SourceEntry/SourceSpan types so the two never drift): keep id/name/kind + the decl body, drop
 *  the redundant name-token span and container. The `elided` flag MUST ride along — renderSource
 *  turns it into the "[body truncated …]" honesty line; dropping it would present a span-capped
 *  body as complete (§3.4). A definition missing a decl object is skipped — the caller's `usable`
 *  guard then routes the whole result to the dense fallback. */
function definitionsToSourceData(defs: readonly JsonValue[]): { sources: SourceEntry[] } {
  const sources: SourceEntry[] = [];
  for (const d of defs) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) continue;
    const o = d as Record<string, JsonValue>;
    const decl = o['decl'];
    if (typeof decl !== 'object' || decl === null || Array.isArray(decl)) continue;
    const dd = decl as Record<string, JsonValue>;
    const span: SourceSpan = {
      file: String(dd['file']),
      line: Number(dd['line']),
      col: Number(dd['col']),
      text: String(dd['text']),
      ...(dd['elided'] === true ? { elided: true } : {}),
    };
    sources.push({
      id: String(o['id']),
      name: String(o['name']),
      kind: String(o['kind']),
      decl: span,
    });
  }
  return { sources };
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
  // Unverified freshness is the dominant signal — surfaced at EVERY verbosity (§3.6):
  // the backstop could not establish what changed (e.g. the drift `git diff` failed), so
  // the answer may be stale. Said outright rather than dressed as fresh; no commit anchor
  // is stamped (suppressed upstream) so this can never read as "current @<commit>".
  if (note.unverified !== undefined) {
    const pend = note.pending > 0 ? `; PENDING ${note.pending} file(s)` : '';
    return `freshness: UNVERIFIED — ${note.unverified.tool} failed (${note.unverified.message}); answer may be stale, re-run or fall back${pend}`;
  }
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
