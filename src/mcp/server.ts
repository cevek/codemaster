// The MCP facade (§11): ONE tool per op (tool-name = op-name) + `status` + `batch`, over stdio.
// The per-op tools are GENERATED from the op catalogue (op-tools.ts) so the capability set lives
// permanently in the agent's tool-list; `status`/`batch` keep handwritten schemas. A per-op call's
// flat `arguments` are routed through the unchanged dispatch path (orchestrator → runOne →
// resolveArgs → canonical zod gate); arguments are re-validated at our zod boundary (schema.ts).
// Usage guidance ships in the initialize response (`instructions`), not in a CLAUDE.md bolt-on.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { systemClock, type Clock } from '../common/async/clock.ts';
import { createIdleExit, type IdleExit } from '../common/async/idle-exit.ts';
import type { JsonValue } from '../core/json.ts';
import type { OrchestratorApi } from '../daemon/orchestrator-api.ts';
import type { OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import { builtinOps } from '../ops/builtins.ts';
import { noopUsageLogger } from '../support/usage-log/create.ts';
import type { UsageLogger } from '../support/usage-log/entry.ts';
import { renderResult, renderResultJson } from '../format/render/render-result.ts';
import { renderStatus, SOURCE_STALE_LINE } from '../format/render/render-status.ts';
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTORS,
  batchToolSchema,
  exampleCallFor,
  statusToolSchema,
} from './schema.ts';
import { buildOpToolDescriptors, buildPerOpRequest, opToolExample } from './op-tools.ts';

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
  /** Usage telemetry sink (spec usage-telemetry): every call's request+response is recorded to
   *  `success.jsonl` / `fail.jsonl`. Default = no-op (a library default with no side effects); the
   *  composition root (`bin.ts`) injects the real file logger. Tests inject a capturing fake. */
  usage?: UsageLogger;
  /** Clock for telemetry timestamps/duration (§16 determinism). Defaults to the system clock. */
  clock?: Clock;
  /** The op catalogue the per-op tools are generated from (§11). Defaults to `builtinOps()` — the
   *  same static union the engine registers, so the tool-list matches what dispatch can route.
   *  Injectable so tests can advertise synthetic ops (the union is per-connection static; ops
   *  whose plugin isn't active for a given repo dispatch to an honest `unavailable`, no
   *  `tools/list_changed` churn). */
  ops?: readonly AnyOpDefinition[];
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

  // Self-staleness banner (§3.6 applied to the tool): a PREFIX on every op/batch text response
  // while the daemon's own source is behind disk — ALWAYS-ON, not one-shot, so a long multi-edit
  // session is warned on EVERY answer it acts on, never just the first (a one-shot latch left the
  // daemon serving pre-edit behavior silently after the first warning — the §3.6 cardinal sin).
  // Response-scoped: a daemon fact at per-response granularity, composed here, never stamped into
  // the per-result Result envelope. `suppressed` is the json guard — a prefix would corrupt a
  // single bare-JSON payload (§12); json consumers read the structured `sourceStale` from `status`.
  const banner = (suppressed: boolean): string =>
    suppressed ? '' : staleBanner(orchestrator.sourceStale());

  // Per-op tools (§11): one generated tool per op, plus the handwritten status/batch. The set is
  // built once at connect — a static UNION over the whole op catalogue (per-connection, multi-repo);
  // an op whose plugin is inactive for the resolved repo dispatches to an honest `unavailable`.
  const ops = options?.ops ?? builtinOps();
  const opDescriptors = buildOpToolDescriptors(ops);
  const opNames = new Set(ops.map((o) => o.name));
  const opExamples = new Map(ops.map((o) => [o.name, opToolExample(o)] as const));
  const badArgsOp = (opName: string, message: string): CallToolResult => {
    const example = opExamples.get(opName);
    const valid = example === undefined ? '' : ` — valid: ${JSON.stringify(example)}`;
    return errorText(`bad args for '${opName}': ${message}${valid}`);
  };

  // Usage telemetry (spec usage-telemetry): default no-op; the composition root injects the real
  // file logger. `clock` stamps each entry's start time + duration (§16 determinism).
  const usage = options?.usage ?? noopUsageLogger;
  const clock = options?.clock ?? systemClock;

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
    usage.dispose();
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
    // Per-op tools first (the capability catalogue), then status/batch. `exampleCall` is internal
    // (it feeds badArgs); advertise only the MCP tool fields.
    tools: [
      ...opDescriptors,
      ...TOOL_DESCRIPTORS.map(({ exampleCall: _exampleCall, ...tool }) => ({ ...tool })),
    ],
  }));

  /** Run one tool call, returning the response AND its success/fail classification + op names
   *  for telemetry. Split out so the enter/leave bracketing and the single usage-log write live
   *  in one place around it, never sprinkled across the ~7 return sites. */
  const handleCall = async (
    request: { params: { name: string; arguments?: unknown } },
    cwd: string,
  ): Promise<HandledCall> => {
    switch (request.params.name) {
      case 'status': {
        const parsed = statusToolSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) return fail(badArgs('status', parsed.error.message));
        const view = await orchestrator.status(cwd, parsed.data.root);
        return ok(text(renderStatus(view, { brief: parsed.data.brief, op: parsed.data.op })));
      }
      case 'batch': {
        const parsed = batchToolSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) return fail(badArgs('batch', parsed.error.message));
        const { sql, return: returnMode, format, verbosity } = parsed.data;
        const ops = parsed.data.requests.map((r) => r.name);
        const outcome = await orchestrator.request(
          cwd,
          parsed.data.root,
          parsed.data.requests as OpRequest[],
          sql !== undefined
            ? { sql, ...(returnMode !== undefined ? { return: returnMode } : {}) }
            : undefined,
        );
        // §3.6 always-on, mirrored onto the batch request-level failure: a stale-daemon batch that
        // fails before producing rows must carry the restart remedy too — same `banner(false)` the
        // success branch below uses (a batch is always text-wrapped per-section, never a single bare
        // json payload, so the prefix is §12-safe regardless of batch format).
        if (!outcome.ok) return fail(errorText(banner(false) + outcome.message), ops);
        return classify(
          text(
            banner(false) +
              renderBatch(outcome.results, parsed.data.requests, {
                sqlPresent: sql !== undefined,
                format,
                verbosity,
              }),
          ),
          outcome.results,
          ops,
        );
      }
      default: {
        // Per-op tool: tool-name = op-name. Route to the unchanged dispatch path (orchestrator →
        // runOne → resolveArgs → canonical gate); the facade only extracts the reserved
        // request/flag keys (§7 facade-blind-extract, guarded by the anti-drift test) from the flat
        // `arguments` and re-uses `opToolSchema` to validate them — never a second op-args gate.
        const opName = request.params.name;
        if (!opNames.has(opName)) {
          return fail(
            errorText(
              `unknown tool '${opName}' — call status for the op catalogue (tools: status, batch, + one per op)`,
            ),
          );
        }
        return runOpTool(opName, request.params.arguments, cwd);
      }
    }
  };

  /** Execute one per-op tool call. Shares the batch path's banner+suppress+sql semantics so a
   *  per-op response carries the self-staleness marker (§3.6) and the single-op sql sugar. */
  const runOpTool = async (opName: string, rawArgs: unknown, cwd: string): Promise<HandledCall> => {
    const ops = [opName];
    const built = buildPerOpRequest(opName, rawArgs);
    if (!built.ok) return fail(badArgsOp(opName, built.message), ops);
    const { request, root, sql, returnMode } = built;
    // The banner is a PREFIX on EVERY text response — success AND error alike (§3.6 always-on): a
    // stale-daemon `unknown_op` for a freshly-added op is exactly where the "restart" remedy matters
    // most. json mode suppresses it: a prefix would corrupt a single bare-JSON payload (§12); json
    // reads `sourceStale` from status. (The facade-side bad-args reject above predates the parse, so
    // its format is unknown and it stays banner-free — a malformed call isn't a stale-behavior read.)
    const suppress = request.format === 'json';
    if (sql !== undefined) {
      // §2.6: single-op sql sugar = a batch of one request aliased `t`.
      const outcome = await orchestrator.request(cwd, root, [{ ...request, as: 't' }], {
        sql,
        ...(returnMode !== undefined ? { return: returnMode } : {}),
      });
      if (!outcome.ok) return fail(errorText(banner(suppress) + outcome.message), ops);
      return classify(
        text(banner(suppress) + renderResults(outcome.results, request.format, request.verbosity)),
        outcome.results,
        ops,
      );
    }
    const outcome = await orchestrator.request(cwd, root, [request]);
    if (!outcome.ok) return fail(errorText(banner(suppress) + outcome.message), ops);
    const result = outcome.results[0];
    if (result === undefined) return fail(errorText('no result (codemaster bug)'), ops);
    return classify(
      opResultText(result, request.format, request.verbosity, () => banner(suppress)),
      [result],
      ops,
    );
  };

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    // enter()/leave() bracket EVERY request so the idle deadline never fires mid-call; leave()
    // is in `finally` so a throwing path still releases the in-flight count (else inFlight would
    // stay >0 and the server could never idle-exit — the orphan would persist).
    idleExit?.enter();
    const startMs = clock.now();
    const cwd = process.cwd();
    let handled: HandledCall;
    try {
      handled = await handleCall(request, cwd);
    } catch (thrown) {
      // §3.6 applied to ourselves: never an escaped exception, the daemon stays up.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      handled = fail(
        errorText(`codemaster internal error: ${message} (daemon still up; please report)`),
      );
    } finally {
      idleExit?.leave();
    }
    // ONE telemetry write, wrapped so a disk/serialize error never touches the request path.
    try {
      usage.record({
        ts: startMs,
        durationMs: clock.now() - startMs,
        tool: request.params.name,
        ops: handled.ops,
        ok: handled.ok,
        cwd,
        args: (request.params.arguments ?? null) as JsonValue,
        response: responseText(handled.result),
        isError: handled.result.isError ?? false,
      });
    } catch {
      /* telemetry must never crash the daemon */
    }
    return handled.result;
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
  // A THUNK so the banner is computed once, after the success/error branch is known. §3.6 is
  // ALWAYS-ON: an op-level `error` (e.g. `unknown_op` for a freshly-added op the stale daemon never
  // loaded) is exactly where the "restart the daemon" remedy matters MOST, so the banner ships on
  // the error branch too. The error branch is plain text in BOTH modes (no json payload to corrupt
  // here); json-suppression of the banner is encoded by the caller's thunk for consistency with the
  // success path, where json consumers instead read the structured `sourceStale` from `status`.
  banner: () => string = () => '',
): CallToolResult {
  if ('error' in result) {
    return errorText(`${banner()}${result.error.kind}: ${result.error.message}`);
  }
  return text(banner() + renderOne(result, format, verbosity));
}

function renderOne(
  result: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if ('error' in result) return `DISPATCH ${result.error.kind}: ${result.error.message}`;
  if (format === 'json') return renderResultJson(result.result);
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

/** The one-line self-staleness banner (§3.6 applied to the tool), prepended to EVERY op/batch text
 *  response while the daemon's own source is behind disk — always-on, never one-shot: a long
 *  multi-edit session must be warned on every answer it acts on, not just the first. Empty when
 *  fresh (no false-positive nag) — pure, exported, unit-tested. A PREFIX so it can never be lost to
 *  the render cap (which trims the tail) and never lands inside a batch's per-section JSON. */
export function staleBanner(sourceStale: boolean): string {
  return sourceStale ? `${SOURCE_STALE_LINE}\n` : '';
}

/** A handled tool call: the agent-facing response plus its telemetry classification
 *  (success/fail and the op name(s) involved). */
interface HandledCall {
  result: CallToolResult;
  ok: boolean;
  ops: string[];
}

function ok(result: CallToolResult, ops: string[] = []): HandledCall {
  return { result, ok: true, ops };
}

function fail(result: CallToolResult, ops: string[] = []): HandledCall {
  return { result, ok: false, ops };
}

/** Classify an op/batch response from its STRUCTURED results, not from `isError`: a
 *  `Result` with `ok:false` (a `ToolFailure` — "couldn't, fall back") renders through a
 *  plain `text()` with no `isError`, so an isError-only check would file it as success.
 *  The call is a success only when every constituent op succeeded. */
function classify(
  result: CallToolResult,
  results: readonly OpResult[],
  ops: string[],
): HandledCall {
  return { result, ok: results.every(opResultOk), ops };
}

function opResultOk(r: OpResult): boolean {
  return !('error' in r) && r.result.ok;
}

/** The text payload of a response, for the telemetry `response` field. */
function responseText(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
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
export function badArgs(tool: 'status' | 'batch', message: string): CallToolResult {
  const example = exampleCallFor(tool);
  const valid = example === undefined ? '' : ` — valid: ${JSON.stringify(example)}`;
  return errorText(`bad args: ${message}${valid}`);
}
