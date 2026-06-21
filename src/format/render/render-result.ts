// Render a `Result<JsonValue>` envelope as dense agent-facing text (§12). Every
// honesty channel of the envelope surfaces explicitly: failure (with the tool named),
// partiality, freshness drift, handle rebinds, truncation. Nothing is dropped to make
// the output prettier — omitting a FreshnessNote is the silent-stale lie.

import type { Result, FreshnessNote, Truncation, Verbosity } from '../../core/result.ts';
import type { HandleRebind } from '../../core/ids.ts';
import type { JsonValue } from '../../core/json.ts';
import { stripShapeTags } from '../../common/shape-tag/tag.ts';
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
  // The envelope is rendered as FOUR segments so the cap can never bury an honesty channel
  // (§12 envelope-seam): `head` is the verdict-before-bulk preamble, `bulk` is the ONLY
  // cappable region (the data render), `tail` carries the load-bearing honesty channels —
  // truncation / handle-rebind / freshness — that MUST survive the cap by construction, and
  // `debug` is the lowest-priority dev trace. Capping the tail-shaped honesty channels off the
  // end (the old single-`lines[]` shape) silently dropped a `freshness: UNVERIFIED` or a
  // `handle: rebound confidence=partial` — the exact silent-stale / §6-misidentification lie.
  const head: string[] = [];
  const bulk: string[] = [];
  const tail: string[] = [];
  const debug: string[] = [];

  if (!result.ok) {
    const partial = result.failure.partial === true;
    head.push(
      `FAIL tool=${result.failure.tool}${partial ? ' partial=true' : ''} — ${result.failure.message}`,
    );
    if (partial && result.data !== undefined) {
      head.push(`data (incomplete — produced before the failure):`);
      bulk.push(renderDense(condenseSpans(result.data, verbosity)));
    }
    // The affordance at the moment of pain (spec-feedback-channel §3): only on a hard
    // FAIL, never on `partial` (which is honest success). The nudge fires where the agent
    // is blocked, not in a doc read once.
    if (!partial) {
      head.push(
        "— blocked or missing a capability? file it: feedback({kind:'bug', title:'…', detail:'…'})",
      );
    }
  } else if (isSqlTableData(result.data)) {
    // sql-mode result (§5.6): a relation, not a span tree — its own dense table.
    bulk.push(renderSqlTable(result.data));
  } else if (isSourceData(result.data)) {
    // `source` op (§3.2): always show bodies (never condensed to loc), budget + elision.
    bulk.push(renderSource(result.data));
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
    bulk.push(usable ? renderSource(src) : renderDense(condenseSpans(result.data, verbosity)));
  } else {
    bulk.push(renderDense(condenseSpans(result.data, verbosity)));
  }

  // Honesty channels — small, load-bearing, and reserved against the cap (`assembleCapped`).
  // truncation first (it qualifies the bulk it follows), then handle, then freshness — the
  // same relative order the single-list render emitted.
  if (result.ok && result.truncated !== undefined) tail.push(renderTruncation(result.truncated));
  if (result.handle !== undefined) tail.push(renderRebind(result.handle));
  if (result.freshness !== undefined) {
    const freshness = renderFreshness(result.freshness, verbosity);
    if (freshness !== undefined) tail.push(freshness);
  }
  // Liberal-intake disclosure (§7 Postel): the off-canonical input spellings we rewrote on
  // THIS call. A small honesty channel — in the reserved tail so it survives the cap — so the
  // agent is never silently second-guessed about how its args were read.
  if (result.intake !== undefined && result.intake.length > 0) {
    tail.push(`interpreted: ${result.intake.join(', ')}`);
  }
  if (result.debug !== undefined && result.debug.length > 0) {
    debug.push('--- debug trace ---', ...result.debug, '--- end debug ---');
  }
  return assembleEnvelope(head, bulk, tail, debug);
}

/** Join the four segments under the char cap. When everything fits, the output is
 *  byte-identical to the flat `head ∪ bulk ∪ tail ∪ debug` join (no reorder — goldens hold).
 *  Over the cap, only `bulk` is trimmed: `head` (verdict) and `tail` (honesty channels) are
 *  reserved against the budget so they survive by construction, and `debug` (a dev trace, not
 *  an honesty channel) is dropped. */
function assembleEnvelope(head: string[], bulk: string[], tail: string[], debug: string[]): string {
  const full = [...head, ...bulk, ...tail, ...debug].join('\n');
  if (full.length <= RENDER_CHAR_CAP) return full;

  const headText = head.join('\n');
  const bulkText = bulk.join('\n');
  const tailText = tail.join('\n');
  const dataLen = bulkText.length;

  // Reserve head + tail (always preserved) + the marker. The marker length varies only by two
  // small integers, so an upper bound keeps the final string ≤ cap without a circular dependency.
  const fixed = [headText, tailText].filter((s) => s.length > 0);
  const reserved = fixed.reduce((n, s) => n + s.length + 1, 0) + MARKER_RESERVE;
  const budget = Math.max(RENDER_CHAR_CAP - reserved, 0);

  const cut = bulkText.lastIndexOf('\n', budget);
  const cappedBulk = bulkText.slice(0, cut > 0 ? cut : budget);
  const marker = capMarker(dataLen, cappedBulk.length);

  // Order in the capped path: head, trimmed bulk, the marker (explaining the bulk cut), then the
  // intact honesty tail. Debug is dropped — it is the lowest priority and never an honesty channel.
  return [headText, cappedBulk, marker, tailText].filter((s) => s.length > 0).join('\n');
}

function capMarker(dataTotal: number, dataShown: number): string {
  return `!! OUTPUT CAPPED: data ${dataTotal} chars, showing first ${dataShown} (honesty channels below preserved). Narrow the query (lower limit, scope by file/dir), use terse, or project columns with sql — do NOT assume this is everything.`;
}

/** Upper bound on `capMarker`'s length — the fixed template plus headroom for the two
 *  integers (each ≤ 7 digits well past any realistic render size). Reserving the bound rather
 *  than the exact length avoids the marker-length ⇄ bulk-budget circularity; the final string
 *  lands a few chars under the cap, which is fine. */
const MARKER_RESERVE = capMarker(0, 0).length + 16;

/** The machine-composition (`format:'json'`) render: the envelope serialized verbatim EXCEPT
 *  the render-only `~shape` tags are stripped from `data` (a deep copy — the live data still
 *  carries them for the text path / sql projector; §19 tear-free). Non-meta key order is
 *  preserved (tags were appended last), so the json payload is byte-identical to the pre-tag
 *  shape — the strip is invisible to the agent. */
export function renderResultJson(result: Result<JsonValue>): string {
  if (result.data === undefined) return JSON.stringify(result);
  return JSON.stringify({ ...result, data: stripShapeTags(result.data) });
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
