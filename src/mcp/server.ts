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
import type { OrchestratorApi } from '../daemon/orchestrator-api.ts';
import type { OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import { builtinOps } from '../ops/builtins.ts';
import { noopUsageLogger } from '../support/usage-log/create.ts';
import type { UsageLogger } from '../support/usage-log/entry.ts';
import { readLastSuspension, type LastSuspension } from '../support/suspension/last-suspension.ts';
import {
  renderStatus,
  sourceStaleBanner,
  type ServingMode,
} from '../format/render/render-status.ts';
import { renderBatch, renderOne, renderResults } from './render-response.ts';
import { capResponse } from './cap-seam.ts';
import {
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTORS,
  batchToolDescriptor,
  batchToolSchema,
  exampleCallFor,
  statusToolSchema,
} from './schema.ts';
import { buildOpToolDescriptors, buildPerOpRequest, opToolExample } from './op-tools.ts';
import { normalizeBatchArguments } from './op-tools.ts';
import { dispatchErrorJson } from './render-dispatch-error.ts';
import { withCallTelemetry } from './call-telemetry.ts';
import {
  classify,
  errorText,
  fail,
  mapText,
  ok,
  responseText,
  text,
  type HandledCall,
} from './handled-call.ts';
import { createFacadeSession, noSession, type ResponseScope } from './facade-session.ts';
import { conceptText } from './lessons.ts';
import { identityFold, type ProseFold } from '../format/render/fold-prose.ts';

/** Idle self-exit wiring for the long-lived `mcp` server (spec-daemon-singleton Stage 1).
 *  `exit` is injectable so tests assert the exit code without killing the runner. */
interface IdleExitOptions {
  clock: Clock;
  idleMs: number;
  exit?: (code: number) => void;
}

export interface ServeMcpOptions {
  /** How THIS process serves codemaster — `daemon` when the orchestrator is the bridge's remote
   *  forwarder, `in-process` when it is a local orchestrator (the `--in-process` path, the
   *  daemon-unreachable fallback, and every test harness). REQUIRED, and deliberately not derivable
   *  from the orchestrator: the daemon process itself hosts a LOCAL orchestrator, so an
   *  `OrchestratorApi`-level flag would answer `in-process` for a client that is talking to a
   *  daemon — the same latent lie that keeps `daemonInfo` off that interface. It decides which
   *  remedy the self-staleness banner may name (§3.6): under `in-process` there is no daemon, so
   *  `codemaster daemon restart` is a no-op and must not be offered as an action. */
  serving: ServingMode;
  /** Bound the process's life to the idle TTL even when stdin-EOF never arrives. Omitted →
   *  no idle deadline (EOF/signal shutdown only). The `mcp` CLI path always supplies it. */
  idle?: IdleExitOptions;
  /** Transport seam (§16 determinism): defaults to stdio; tests inject an in-memory pair to
   *  drive the real handler. An injected transport ALSO flips the default `exit` to a no-op
   *  (see `exit` below) — the structural guard that keeps an in-process test from hard-exiting
   *  the runner. */
  transport?: Transport;
  /** Process-exit seam for `shutdown` (onclose / stdin-EOF / SIGTERM / SIGINT / idle). The DEFAULT
   *  is derived from `transport`, not hardcoded: real stdio (no `transport`) ⇒ `process.exit` (the
   *  daemon MUST terminate — the `mcp` CLI path, bin.ts, is thus untouched); an injected `transport`
   *  ⇒ a no-op (a test context — calling `process.exit` would hard-exit the test runner with code 0
   *  mid-run, masking a failed subtest as a false-green vacuum-pass). So no per-test discipline can
   *  reopen that hole. An explicit `exit` (or `idle.exit`) overrides the default — used by the
   *  masking-arm of the discriminating test to force `process.exit` even over an injected transport. */
  exit?: (code: number) => void;
  /** Usage telemetry sink (spec usage-telemetry): every call's request+response is recorded to
   *  `success.jsonl` / `fail.jsonl`. Default = no-op (a library default with no side effects); the
   *  composition root (`bin.ts`) injects the real file logger. Tests inject a capturing fake. */
  usage?: UsageLogger;
  /** Clock for telemetry timestamps/duration (§16 determinism). Defaults to the system clock. */
  clock?: Clock;
  /** The machine's last sleep/wake cycle for the usage record's `suspendedMs`. Defaults to the
   *  kernel's (darwin `sysctl`, read only for calls of ≥10 s); tests inject a fake. */
  lastSuspension?: LastSuspension;
  /** The op catalogue the per-op tools are generated from (§11). Defaults to `builtinOps()` — the
   *  same static union the engine registers, so the tool-list matches what dispatch can route.
   *  Injectable so tests can advertise synthetic ops (the union is per-connection static; ops
   *  whose plugin isn't active for a given repo dispatch to an honest `unavailable`, no
   *  `tools/list_changed` churn). */
  ops?: readonly AnyOpDefinition[];
  /** Remember, per connection, which explanatory prose was already shown in full and fold its
   *  repeats (§12), stamp the build once, and state a repeat `status` as a diff (§11). Off by
   *  default: tests and library callers get byte-stable responses; `bin.ts` turns it on. */
  session?: boolean;
}

export async function serveMcp(
  orchestrator: OrchestratorApi,
  version: string,
  options: ServeMcpOptions,
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
  const session = options.session === true ? createFacadeSession() : noSession;
  // The prefix of a TEXT response: the stale banner (an alarm — present on every stale response,
  // folded to its short form after the first full showing) and, once per session, the build stamp.
  const prefix = (suppressed: boolean, scope: ResponseScope, cwd: string): string =>
    suppressed
      ? ''
      : scope.foldFor(cwd)(staleBanner(orchestrator.sourceStale(), options.serving)) +
        scope.buildLine(orchestrator.buildId());

  // Per-op tools (§11): one generated tool per op, plus the handwritten status/batch. The set is
  // built once at connect — a static UNION over the whole op catalogue (per-connection, multi-repo);
  // an op whose plugin is inactive for the resolved repo dispatches to an honest `unavailable`.
  const ops = options.ops ?? builtinOps();
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
  const usage = options.usage ?? noopUsageLogger;
  const clock = options.clock ?? systemClock;

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
  // §1 never-hang ↔ §16 honest-tests, reconciled structurally: an injected `transport` is a test,
  // where `process.exit` would kill the runner (false-green); real stdio is the daemon, which MUST
  // terminate. Explicit `exit`/`idle.exit` override either (the test's masking-arm forces exit).
  const exit =
    options.exit ??
    options.idle?.exit ??
    (options.transport !== undefined
      ? (): void => undefined
      : (code: number): void => process.exit(code));
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
  if (options.idle !== undefined) {
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
      ...TOOL_DESCRIPTORS.filter((d) => d.name !== 'batch').map(
        ({ exampleCall: _exampleCall, ...tool }) => ({ ...tool }),
      ),
      batchToolDescriptor([...opNames]),
    ],
  }));

  /** Run one tool call, returning the response AND its success/fail classification + op names
   *  for telemetry. Split out so the enter/leave bracketing and the single usage-log write live
   *  in one place around it, never sprinkled across the ~7 return sites. */
  const handleCall = async (
    request: { params: { name: string; arguments?: unknown } },
    cwd: string,
    scope: ResponseScope,
  ): Promise<HandledCall> => {
    const banner = (suppressed: boolean): string => prefix(suppressed, scope, cwd);
    switch (request.params.name) {
      case 'status': {
        const parsed = statusToolSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) return fail(badArgs('status', parsed.error.message));
        if (parsed.data.concept !== undefined) return ok(text(conceptText(parsed.data.concept)));
        const view = await orchestrator.status(cwd, parsed.data.root);
        const { brief, full, op } = parsed.data;
        const terse = full !== true && op === undefined;
        if (terse) scope.noteStatus(view);
        const recall = terse ? scope.statusRecall() : undefined;
        return ok(text(renderStatus(view, { brief, full, op, serving: options.serving, recall })));
      }
      case 'batch': {
        // §7/§11: normalize each request's flat `{op,…}` envelope to canonical `{name,args}` before
        // the schema strips `op` (which would misdispatch the request's `name` VALUE as the op).
        const parsed = batchToolSchema.safeParse(normalizeBatchArguments(request.params.arguments));
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
        const requests = parsed.data.requests;
        const toolRoot = parsed.data.root;
        return classify(
          text(
            banner(false) +
              renderBatch(
                outcome.results,
                requests,
                { sqlPresent: sql !== undefined, format, verbosity },
                (i) => scope.foldFor(requests[i]?.root ?? toolRoot ?? cwd),
              ),
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
        return runOpTool(opName, request.params.arguments, cwd, banner, scope);
      }
    }
  };

  /** Execute one per-op tool call. Shares the batch path's banner+suppress+sql semantics so a
   *  per-op response carries the self-staleness marker (§3.6) and the single-op sql sugar. */
  const runOpTool = async (
    opName: string,
    rawArgs: unknown,
    cwd: string,
    banner: (suppressed: boolean) => string,
    scope: ResponseScope,
  ): Promise<HandledCall> => {
    const ops = [opName];
    const built = buildPerOpRequest(opName, rawArgs);
    if (!built.ok) return fail(badArgsOp(opName, built.message), ops);
    const { request, root, sql, returnMode } = built;
    // A `format:'json'` per-op response is a single bare JSON object (renderOne json, or the
    // dispatch-error-json branch) — the seam cap must REPLACE it over-limit, not tail-truncate. The
    // sql sugar stays bare json only when it yields exactly ONE result (return:'all' with N>1 → text
    // `[i] name` sections). Failure branches below are plain-text messages → text-path cap.
    const bareJson = request.format === 'json';
    // The banner is a PREFIX on EVERY text response — success AND error alike (§3.6 always-on): a
    // stale-daemon `unknown_op` for a freshly-added op is exactly where the "restart" remedy matters
    // most. json mode suppresses it: a prefix would corrupt a single bare-JSON payload (§12); json
    // reads `sourceStale` from status. (The facade-side bad-args reject above predates the parse, so
    // its format is unknown and it stays banner-free — a malformed call isn't a stale-behavior read.)
    const suppress = request.format === 'json';
    const fold = scope.foldFor(root ?? cwd);
    if (sql !== undefined) {
      // §2.6: single-op sql sugar = a batch of one request aliased `t`.
      const outcome = await orchestrator.request(cwd, root, [{ ...request, as: 't' }], {
        sql,
        ...(returnMode !== undefined ? { return: returnMode } : {}),
      });
      if (!outcome.ok) return fail(errorText(banner(suppress) + outcome.message), ops);
      return classify(
        text(
          banner(suppress) +
            renderResults(outcome.results, request.format, request.verbosity, fold),
        ),
        outcome.results,
        ops,
        bareJson && outcome.results.length === 1,
      );
    }
    const outcome = await orchestrator.request(cwd, root, [request]);
    if (!outcome.ok) return fail(errorText(banner(suppress) + outcome.message), ops);
    const result = outcome.results[0];
    if (result === undefined) return fail(errorText('no result (codemaster bug)'), ops);
    return classify(
      opResultText(result, request.format, request.verbosity, () => banner(suppress), fold),
      [result],
      ops,
      bareJson,
    );
  };

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const cwd = process.cwd();
      const scope = session.begin();
      // The whole call runs inside the telemetry span (call-telemetry.ts): breadcrumb → dispatch →
      // record → clear, with the ordering guarantees that make a fatal visible stated there.
      const sent = await withCallTelemetry({
        usage,
        clock,
        tool: request.params.name,
        args: request.params.arguments,
        cwd,
        lastSuspension: options.lastSuspension ?? readLastSuspension,
        run: async () => {
          // enter()/leave() bracket EVERY request so the idle deadline never fires mid-call; leave()
          // is in `finally` so a throwing path still releases the in-flight count (else inFlight would
          // stay >0 and the server could never idle-exit — the orphan would persist).
          idleExit?.enter();
          let handled: HandledCall;
          try {
            handled = await handleCall(request, cwd, scope);
          } catch (thrown) {
            // §3.6 applied to ourselves: never an escaped exception, the daemon stays up.
            const message = thrown instanceof Error ? thrown.message : String(thrown);
            handled = fail(
              errorText(`codemaster internal error: ${message} (daemon still up; please report)`),
            );
          } finally {
            idleExit?.leave();
          }
          // §3.4/§12 UNIVERSAL seam cap: guarantee the serialized frame stays under the harness
          // ceiling — a backstop over the per-op §12 caps so no op/status/batch/sql can blow the
          // limit. At the single chokepoint BEFORE the telemetry write (the log records exactly what
          // the agent got); no-op under the cap (byte-identical, so goldens are untouched).
          const result = capResponse(
            handled.bareJson ? handled.result : mapText(handled.result, scope.repair),
            handled.bareJson,
          );
          return {
            ok: handled.ok,
            ops: handled.ops,
            response: responseText(result),
            isError: result.isError ?? false,
            value: result,
          };
        },
      });
      // Counted as delivered only now, as the SDK sends it — never for a cancelled call, whose answer
      // the client never receives.
      if (!extra.signal.aborted) scope.commit(responseText(sent));
      return sent;
    },
  );

  const transport = options.transport ?? new StdioServerTransport();
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
  // ALWAYS-ON: an op-level `error` (e.g. a stale-daemon `unknown_op`) is exactly where "restart the
  // daemon" matters MOST, so the banner ships on the TEXT error branch too. Json suppresses it (the
  // caller's thunk returns '' under json — a bare JSON envelope, §12; json reads `sourceStale`).
  banner: () => string = () => '',
  fold: ProseFold = identityFold,
): CallToolResult {
  if ('error' in result) {
    // Under json a dispatch rejection is a valid JSON envelope so a `| jq` consumer never meets
    // non-JSON text on a success-shaped payload (§3, t-337633). Text keeps the dense line + banner.
    if (format === 'json') return errorText(dispatchErrorJson(result.error));
    return errorText(`${banner()}${result.error.kind}: ${result.error.message}`);
  }
  return text(banner() + renderOne(result, format, verbosity, fold));
}

/** The one-line self-staleness banner (§3.6 applied to the tool), prepended to EVERY op/batch text
 *  response while the daemon's own source is behind disk — always-on, never one-shot: a long
 *  multi-edit session must be warned on every answer it acts on, not just the first. Empty when
 *  fresh (no false-positive nag) — pure, exported, unit-tested. A PREFIX so it can never be lost to
 *  the render cap (which trims the tail) and never lands inside a batch's per-section JSON. The
 *  wording (and its `serving`-dependent remedy) has ONE home — `format/render/render-status.ts` —
 *  shared with `status`, so the two surfaces cannot drift. */
export function staleBanner(sourceStale: boolean, serving: ServingMode): string {
  return sourceStale ? `${sourceStaleBanner(serving)}\n` : '';
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
