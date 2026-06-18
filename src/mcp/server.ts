// The MCP facade (§11): exactly three tools — op / status / batch — over stdio.
// Low-level SDK API (tools/list + tools/call handlers) with handwritten JSON Schemas;
// arguments are re-validated with our own zod boundary (schema.ts). Usage guidance
// ships in the initialize response (`instructions`), not in a CLAUDE.md bolt-on.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Clock } from '../common/async/clock.ts';
import { createIdleExit, type IdleExit } from '../common/async/idle-exit.ts';
import type { OrchestratorApi } from '../daemon/orchestrator-api.ts';
import type { OpRequest, OpResult } from '../ops/contracts.ts';
import { renderResult } from '../format/render/render-result.ts';
import { renderStatus, SOURCE_STALE_LINE } from '../format/render/render-status.ts';
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTORS,
  batchToolSchema,
  exampleCallFor,
  opToolSchema,
  statusToolSchema,
} from './schema.ts';

/** Idle self-exit wiring for the long-lived `mcp` server (spec-daemon-singleton Stage 1).
 *  `exit` is injectable so tests assert the exit code without killing the runner. */
interface IdleExitOptions {
  clock: Clock;
  idleMs: number;
  exit?: (code: number) => void;
}

export interface ServeMcpOptions {
  /** Bound the process's life to the idle TTL even when stdin-EOF never arrives. Omitted →
   *  no idle deadline (EOF/signal shutdown only). The `mcp` CLI path always supplies it. */
  idle?: IdleExitOptions;
  /** Transport seam (§16 determinism): defaults to stdio; tests inject an in-memory pair to
   *  drive the real handler. */
  transport?: Transport;
}

export async function serveMcp(
  orchestrator: OrchestratorApi,
  version: string,
  options?: ServeMcpOptions,
): Promise<void> {
  const server = new Server(
    { name: 'codemaster', version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // Self-staleness banner is ONE-SHOT per session (spec-stresstest §6): see `createOnceBanner`.
  const sessionBanner = createOnceBanner(() => orchestrator.sourceStale());

  // The idle deadline is created (and the timer armed) only when `idle` is supplied — i.e.
  // the `mcp` serve path. The CLI one-shot path (`status`/`op`) never calls serveMcp, so no
  // timer can leak into it (spec-daemon-singleton §5).
  let idleExit: IdleExit | undefined;

  // The MCP client owns our lifetime: when it closes stdin (session over), dispose
  // engines (watchers would otherwise keep the event loop alive — a zombie per
  // session) and exit. The idle deadline is the belt-and-suspenders for a missed EOF.
  // Five triggers can call shutdown (onclose / stdin 'end' / SIGTERM / SIGINT / idle), so a
  // re-entry guard keeps it to one dispose+exit (dispose is idempotent anyway — this just
  // avoids the redundant calls).
  const exit = options?.idle?.exit ?? ((code: number): void => process.exit(code));
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    idleExit?.stop();
    void orchestrator
      .dispose()
      .catch(() => undefined)
      .finally(() => exit(0));
  };
  if (options?.idle !== undefined) {
    idleExit = createIdleExit({
      clock: options.idle.clock,
      idleMs: options.idle.idleMs,
      onIdle: shutdown,
    });
  }
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // `exampleCall` is internal (it feeds badArgs); advertise only the MCP tool fields.
    tools: TOOL_DESCRIPTORS.map(({ exampleCall: _exampleCall, ...tool }) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    // enter()/leave() bracket EVERY request so the idle deadline never fires mid-call; leave()
    // is in `finally` so a throwing path still releases the in-flight count (else inFlight would
    // stay >0 and the server could never idle-exit — the orphan would persist).
    idleExit?.enter();
    const cwd = process.cwd();
    try {
      switch (request.params.name) {
        case 'status': {
          const parsed = statusToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs('status', parsed.error.message);
          const view = await orchestrator.status(cwd, parsed.data.root);
          return text(renderStatus(view, { brief: parsed.data.brief, op: parsed.data.op }));
        }
        case 'op': {
          const parsed = opToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs('op', parsed.error.message);
          const { root, sql, return: returnMode, ...req } = parsed.data;
          // The one-shot banner (§6) is consumed ONLY where it actually ships in a text response —
          // NOT eagerly, or an early error return (bad route / dispatch fail / op-level error) would
          // silently spend the session's single warning and leave every later call quiet (a stale
          // daemon never owning up). `sessionBanner` is therefore called inside the success returns
          // below, never before them; json mode passes `true` (a prefix corrupts the payload) and
          // does not consume the one-shot.
          const suppress = req.format === 'json';
          if (sql !== undefined) {
            // §2.6: single-op sql sugar = a batch of one request aliased `t`.
            const outcome = await orchestrator.request(
              cwd,
              root,
              [{ ...(req as OpRequest), as: 't' }],
              { sql, ...(returnMode !== undefined ? { return: returnMode } : {}) },
            );
            if (!outcome.ok) return errorText(outcome.message);
            return text(
              sessionBanner(suppress) + renderResults(outcome.results, req.format, req.verbosity),
            );
          }
          const outcome = await orchestrator.request(cwd, root, [req as OpRequest]);
          if (!outcome.ok) return errorText(outcome.message);
          const result = outcome.results[0];
          if (result === undefined) return errorText('no result (codemaster bug)');
          return opResultText(result, req.format, req.verbosity, () => sessionBanner(suppress));
        }
        case 'batch': {
          const parsed = batchToolSchema.safeParse(request.params.arguments ?? {});
          if (!parsed.success) return badArgs('batch', parsed.error.message);
          const { sql, return: returnMode, format, verbosity } = parsed.data;
          const outcome = await orchestrator.request(
            cwd,
            parsed.data.root,
            parsed.data.requests as OpRequest[],
            sql !== undefined
              ? { sql, ...(returnMode !== undefined ? { return: returnMode } : {}) }
              : undefined,
          );
          if (!outcome.ok) return errorText(outcome.message);
          return text(
            sessionBanner(false) +
              renderBatch(outcome.results, parsed.data.requests, {
                sqlPresent: sql !== undefined,
                format,
                verbosity,
              }),
          );
        }
        default:
          return errorText(`unknown tool '${request.params.name}' (tools: op, status, batch)`);
      }
    } catch (thrown) {
      // §3.6 applied to ourselves: never an escaped exception, the daemon stays up.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return errorText(`codemaster internal error: ${message} (daemon still up; please report)`);
    } finally {
      idleExit?.leave();
    }
  });

  const transport = options?.transport ?? new StdioServerTransport();
  await server.connect(transport);
  // Arm the initial deadline only after connect — a server that never receives a request still
  // self-exits after the TTL.
  idleExit?.start();
}

export function opResultText(
  result: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
  // A THUNK, not a string: an op-level `error` result must NOT consume the one-shot banner (§6) —
  // it's called only on the success branch, where the banner truly ships.
  banner: () => string = () => '',
): CallToolResult {
  if ('error' in result) {
    return errorText(`${result.error.kind}: ${result.error.message}`);
  }
  return text(banner() + renderOne(result, format, verbosity));
}

function renderOne(
  result: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if ('error' in result) return `DISPATCH ${result.error.kind}: ${result.error.message}`;
  if (format === 'json') return JSON.stringify(result.result);
  return renderResult(result.result, verbosity ?? 'terse');
}

/** Render one-or-more op results (the op-sql sugar yields 1 with return:'sql', or N+1
 *  with return:'all'). A single result renders bare; several get `[i] name` headers. */
function renderResults(
  results: readonly OpResult[],
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if (results.length === 1 && results[0] !== undefined) {
    return renderOne(results[0], format, verbosity);
  }
  return results.map((r, i) => `[${i}] ${r.name}\n${renderOne(r, format, verbosity)}`).join('\n\n');
}

type ReqFlags = {
  format?: 'text' | 'json' | undefined;
  verbosity?: 'terse' | 'normal' | 'full' | undefined;
};
type BatchFlags = { sqlPresent: boolean } & ReqFlags;

/** Render a batch's ordered results. The synthetic `sql` result (the join output) renders
 *  with the BATCH-level `format`/`verbosity` — the per-request flags belong to the
 *  producers, not the join (review fix #2). Exported so the flag routing is unit-tested. */
export function renderBatch(
  results: readonly OpResult[],
  requests: readonly ReqFlags[],
  batch: BatchFlags,
): string {
  return results
    .map((r, i) => {
      const isSqlResult = batch.sqlPresent && r.name === 'sql';
      const format = isSqlResult ? batch.format : requests[i]?.format;
      const verbosity = isSqlResult ? batch.verbosity : requests[i]?.verbosity;
      return `[${i}] ${r.name}\n${renderOne(r, format, verbosity)}`;
    })
    .join('\n\n');
}

/** The one-line self-staleness banner (§3.6 applied to the tool). Prepended to op/batch
 *  responses when the daemon's own source moved since spawn, so an agent acting on a
 *  stale answer is told to restart the daemon. Empty when fresh — pure, exported, unit-tested. */
export function staleBanner(sourceStale: boolean): string {
  return sourceStale ? `${SOURCE_STALE_LINE}\n` : '';
}

/** A session-scoped, ONE-SHOT self-staleness banner (spec-stresstest §6). The "daemon restart"
 *  warning is un-actionable mid-session (an agent can't restart the daemon on demand), so repeating it
 *  on every op/batch response is noise that erodes trust. This returns a function that emits the
 *  banner on the FIRST response that would carry it (stale + not suppressed), then stays silent for
 *  the rest of the session — `status().sourceStale` still reports the true state on demand.
 *  `suppressed` is the json-mode guard: prepending a line to a single JSON payload would corrupt it
 *  (§12), and a suppressed call must NOT consume the one-shot (so a later text call still warns once). */
export function createOnceBanner(sourceStale: () => boolean): (suppressed: boolean) => string {
  let emitted = false;
  return (suppressed: boolean): string => {
    if (suppressed || emitted) return '';
    const banner = staleBanner(sourceStale());
    if (banner === '') return '';
    emitted = true;
    return banner;
  };
}

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function errorText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A validation rejection that also teaches the fix: the zod message plus a minimal
 *  valid arguments object for the tool (§1.2, §7 "agents author blind; pointed errors").
 *  The example alone is enough to author the corrected call. Exported so the
 *  example-carrying contract is unit-tested. */
export function badArgs(tool: 'op' | 'status' | 'batch', message: string): CallToolResult {
  const example = exampleCallFor(tool);
  const valid = example === undefined ? '' : ` — valid: ${JSON.stringify(example)}`;
  return errorText(`bad args: ${message}${valid}`);
}
