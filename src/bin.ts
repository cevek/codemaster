#!/usr/bin/env node
// codemaster — CLI / process entry (composition root). Wires clock + debug + watcher
// + built-in plugins/ops into an orchestrator, then serves MCP over stdio
// (`codemaster mcp`) or answers one-shot CLI queries (`status`, `op`).
//
// stdout carries ONLY the agent-facing payload; all tracing goes to stderr/file via
// the debug subsystem (§13).

import process from 'node:process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from './common/async/clock.ts';
import { createDebugSystem } from './support/debug/system.ts';
import { createStderrSink } from './support/debug/stderr-sink.ts';
import { createChokidarWatcher } from './support/watch/chokidar.ts';
import { Orchestrator, DEFAULT_IDLE_EVICTION_MIN } from './daemon/orchestrator.ts';
import { loadConfig } from './support/config-load/load.ts';
import { isOk } from './common/result/narrow.ts';
import { builtinPlugins } from './daemon/builtin-plugins.ts';
import { builtinOps } from './ops/builtins.ts';
import { renderStatus } from './format/render/render-status.ts';
import { serveMcp } from './mcp/server.ts';
import { defaultUsageLogger } from './support/usage-log/default.ts';
import { serveDaemon } from './daemon/daemon-server.ts';
import { connectOrSpawnDaemon } from './daemon/connect-or-spawn.ts';
import { spawnDaemon } from './daemon/spawn-daemon.ts';
import { runDaemonCommand } from './daemon/manage.ts';
import { createRemoteOrchestrator } from './daemon/remote-orchestrator.ts';
import { createUnixSocketTransport } from './support/transport/unix-socket.ts';
import { socketPath } from './support/transport/socket-path.ts';
import { pidfilePathFor } from './support/pidfile/write.ts';
import { installWatchdog } from './support/watchdog/install.ts';
import { makeProcessHostFactory } from './daemon/process-host-factory.ts';
import { serveEngineChild } from './daemon/engine-child.ts';
import { flagIssue, flagValue, hasFlag } from './cli/flags.ts';
import {
  BATCH_USAGE,
  parseBatchCommand,
  runCompose,
  runOp,
  runOpSql,
  type CliOutcome,
} from './cli/compose.ts';
import { parseOpCommand } from './cli/op-command.ts';

/** Per-request reply deadline for the bridge (§1 never-hang), ALSO the process-mode child's
 *  request/kill deadline (one constant → the two-tier scheme). Set STRICTLY above the in-op graceful
 *  op deadline (120s, HostCancellationToken → `ToolFailure{timeout,partial}`) so a cancellable heavy
 *  op returns its graceful partial BEFORE the bridge gives up or the process host hard-kills the
 *  child — a truly-wedged (uncancellable program build) op is caught by the SIGKILL at 150s, the
 *  bridge relays the kill-induced failure. Generous — a cold find_usages runs tens of seconds — but
 *  bounded so nothing waits unboundedly. */
const BRIDGE_REPLY_DEADLINE_MS = 150_000;

const VERSION = '0.1.0';

function buildOrchestrator(): Orchestrator {
  const debug = createDebugSystem(systemClock, process.env['CODEMASTER_DEBUG'] ?? '');
  if (process.env['CODEMASTER_DEBUG'] !== undefined) debug.addSink(createStderrSink());
  // The child bin for `process`-mode isolation (§2) — this same entry, re-invoked as
  // `daemon serve-engine`. Under a global/npx install `import.meta.url` still points at
  // codemaster's own source, so the child resolves the SAME bundled TS as the parent (§19).
  const binPath = fileURLToPath(import.meta.url);
  return new Orchestrator({
    clock: systemClock,
    debug,
    watcher: createChokidarWatcher(systemClock),
    version: VERSION,
    pluginsFor: builtinPlugins,
    opsFor: () => builtinOps(),
    spawnProcessHost: makeProcessHostFactory({
      binPath,
      version: VERSION,
      requestDeadlineMs: BRIDGE_REPLY_DEADLINE_MS,
      sockDir: process.env['CODEMASTER_SOCK_DIR'],
      // §13: trace the child's resolved heap ceiling like its sibling isolation decision, so which
      // ceiling a child got is greppable rather than only visible in `ps`.
      trace: debug.ns('daemon'),
    }),
  });
}

/** The `mcp` server's idle self-exit TTL in ms, from `daemon.idleEvictionMinutes` at `cwd`
 *  (fallback = the shared engine default). A missing/unreadable config is the default — never a
 *  crash on the serve path. `CODEMASTER_MCP_IDLE_MS` is a test/debug override (sub-second TTL for
 *  the real-process smoke; production uses whole minutes via config) — it wins when a positive
 *  finite number, else ignored. */
function mcpIdleMs(cwd: string): number {
  const envMs = Number(process.env['CODEMASTER_MCP_IDLE_MS']);
  if (Number.isFinite(envMs) && envMs > 0) return envMs;
  const loaded = loadConfig(cwd);
  const minutes = isOk(loaded)
    ? (loaded.data.config.daemon?.idleEvictionMinutes ?? DEFAULT_IDLE_EVICTION_MIN)
    : DEFAULT_IDLE_EVICTION_MIN;
  return minutes * 60_000;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Write a composed command's outcome (payload → stdout, diagnostics → stderr), release the
 *  one-shot orchestrator, and hand back its exit code. */
async function emit(outcome: CliOutcome, orchestrator: Orchestrator): Promise<number> {
  for (const line of outcome.stdout) out(line);
  for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
  await orchestrator.dispose();
  return outcome.code;
}

async function main(): Promise<number> {
  // §3.6: a stray rejection must never take the front door down.
  process.on('uncaughtException', (err) => process.stderr.write(`codemaster: ${err.message}\n`));
  process.on('unhandledRejection', (err) =>
    process.stderr.write(`codemaster: unhandled rejection: ${String(err)}\n`),
  );

  const args = process.argv.slice(2);
  // `--root` is a position-free GLOBAL flag: extract it from the whole argv BEFORE shifting the
  // subcommand, so `--root <dir> op …` parses as well as `op … --root <dir>` (t-713862). Read with
  // `flagValue` like every other value flag — read with the space-form-only `argValue` it was the
  // ONE flag that rejected its own `=` spelling, so `--format=json` worked and `--root=/x` did not.
  // It splices wherever it sits, so the shift below always lands on the real subcommand token.
  const root = flagValue(args, '--root');
  const command = args.shift();

  switch (command) {
    case 'daemon': {
      // `daemon` is a sub-router (spec-daemon-cli). `serve` is the INTERNAL long-lived singleton the
      // bridge spawns (spec-daemon-singleton §2) — it needs an orchestrator and stays here. The
      // user-facing management verbs (`start`/`stop`/`restart`/`status`) are pure socket clients and
      // live in `daemon/manage.ts`. Bare `daemon` (or an unknown verb) prints usage.
      const verb = args.shift();
      if (verb === 'serve') {
        // Hosts one in-process orchestrator behind the unix socket, shared across every bridge.
        // Wedge watchdog only (t-095661): the daemon is DETACHED by design (parent → init), so
        // orphan-exit is off here; its production hard-guarantee is §9 kill-on-deadline.
        installWatchdog({ clock: systemClock, orphanAware: false });
        const orchestrator = buildOrchestrator();
        const socket = socketPath(VERSION, process.env['CODEMASTER_SOCK_DIR']);
        const transport = createUnixSocketTransport(socket);
        try {
          await serveDaemon({
            orchestrator,
            transport,
            clock: systemClock,
            idleMs: mcpIdleMs(process.cwd()),
            // Crash breadcrumbs for the daemon's OWN dispatch (t-305430). NOT a second call log:
            // the agent-facing process (the bridge below) owns call accounting and writes the one
            // record per call, so this never double-counts. It exists so a daemon fatal is
            // attributable to the op that was running — the bridge outlives its daemon and can only
            // report a closed socket.
            usage: defaultUsageLogger(),
            // Kill-target-hint pidfile (t-000051) for the management-verb wedge recovery.
            pidfile: { path: pidfilePathFor(socket), socket, version: VERSION },
          });
        } catch (err) {
          // Lost the bind race (§19) — another daemon already holds the socket. Exit cleanly; the
          // bridges converge on the winner. Any other bind error is a real failure.
          await orchestrator.dispose().catch(() => undefined);
          if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return 0;
          throw err;
        }
        return -1; // long-lived
      }
      if (verb === 'serve-engine') {
        // The INTERNAL process-mode engine child (§2/§9), forked by `createProcessHost`. Hosts
        // ONE workspace engine over the fork IPC channel; its heap is bounded by the
        // `--max-old-space-size` the parent APPENDS at fork (§9 `heap-ceiling.ts` — the parent
        // carries no such flag itself), so a warm that would OOM the shared daemon dies HERE instead.
        // Config (root/stateDir/version) arrives via env from `forkEngineChild`.
        const engineRoot = process.env['CODEMASTER_ENGINE_ROOT'];
        if (engineRoot === undefined) {
          process.stderr.write('daemon serve-engine: CODEMASTER_ENGINE_ROOT not set\n');
          return 2;
        }
        const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
        await serveEngineChild({
          root: engineRoot,
          version: process.env['CODEMASTER_ENGINE_VERSION'] ?? VERSION,
          stateDir: process.env['CODEMASTER_ENGINE_STATE_DIR'] ?? path.join(home, '.codemaster'),
          pluginsFor: builtinPlugins,
          opsFor: () => builtinOps(),
        });
        return -1; // long-lived until the parent disposes or dies
      }
      if (verb === undefined) {
        process.stderr.write(
          'usage: codemaster daemon <status|start|stop|restart>\n  (serve is the internal verb spawned by the MCP bridge)\n',
        );
        return 2;
      }
      const socket = socketPath(VERSION, process.env['CODEMASTER_SOCK_DIR']);
      const transport = createUnixSocketTransport(socket);
      const binPath = fileURLToPath(import.meta.url);
      const result = await runDaemonCommand(verb, {
        transport,
        socketPath: socket,
        pidfilePath: pidfilePathFor(socket),
        clock: systemClock,
        spawnDaemon: () => spawnDaemon(binPath, process.env['CODEMASTER_SOCK_DIR']),
      });
      for (const line of result.lines) out(line);
      return result.code;
    }
    case 'mcp': {
      const idleMs = mcpIdleMs(root ?? process.cwd());
      // Usage telemetry on the agent-facing MCP path (spec usage-telemetry): records every
      // request+response to ~/.codemaster/usage/{success,fail}.jsonl (opt out CODEMASTER_USAGE_LOG=0).
      const usage = defaultUsageLogger();
      // `--in-process` escape hatch (spec §5): serve a local orchestrator directly, no daemon —
      // for debugging and the self-dev loop. Carries the Stage-1 idle self-exit.
      if (hasFlag(args, '--in-process')) {
        // Never-hang backstops (t-095661): the in-process path has NO external killer, so a wedge
        // watchdog (worker thread) + orphan poll self-reap. Best-effort — a failed install is a
        // no-op, never a broken serve path.
        installWatchdog({ clock: systemClock, orphanAware: true });
        await serveMcp(buildOrchestrator(), VERSION, {
          idle: { clock: systemClock, idleMs },
          usage,
        });
        return -1;
      }
      // The bridge (spec-daemon-singleton §2): a dumb stdio↔socket proxy. Connect to (or spawn) the
      // singleton daemon and forward MCP requests over the socket. It holds no project state and
      // does no heavy work, so its loop never blocks → stdin-EOF is always processed promptly (the
      // real orphan fix). The daemon owns idle-exit, so the bridge needs none.
      const socket = socketPath(VERSION, process.env['CODEMASTER_SOCK_DIR']);
      const transport = createUnixSocketTransport(socket);
      const binPath = fileURLToPath(import.meta.url);
      const connection = await connectOrSpawnDaemon({
        transport,
        socketPath: socket,
        clock: systemClock,
        spawnDaemon: () => spawnDaemon(binPath, process.env['CODEMASTER_SOCK_DIR']),
      });
      if (connection === undefined) {
        // Daemon unreachable (spawn/connect failed within budget) — fall back to in-process serving
        // (Stage-1 behavior). Worst case is "no amortization", never a hang or a hard failure (D1).
        await serveMcp(buildOrchestrator(), VERSION, {
          idle: { clock: systemClock, idleMs },
          usage,
        });
        return -1;
      }
      const remote = createRemoteOrchestrator({
        connection,
        clock: systemClock,
        replyDeadlineMs: BRIDGE_REPLY_DEADLINE_MS,
        version: VERSION,
      });
      await serveMcp(remote, VERSION, { usage });
      return -1; // stays alive serving stdio until the client closes stdin
    }
    case 'status': {
      // Render dials mirror the MCP `status` tool (spec-agent-surface-ergonomics, t-523883): the
      // default is TERSE; `--full` dumps every op's schema+notes, `--op <name>` renders one op's
      // detail, `--brief` is the back-compat alias of the default. Extract them BEFORE the stray
      // check so they never read as unrecognized.
      const full = hasFlag(args, '--full');
      const brief = hasFlag(args, '--brief');
      const op = flagValue(args, '--op');
      // `--root` (extracted globally above) + the render dials are the only flags `status` accepts.
      // Anything else `--`-prefixed is unread input — reject, never drop (§3 silent-swallow).
      const issue = flagIssue(args, {
        value: ['--root', '--op'],
        bool: ['--full', '--brief'],
        consumed: [
          ...(root !== undefined ? ['--root'] : []),
          ...(op !== undefined ? ['--op'] : []),
        ],
      });
      if (issue !== undefined) {
        process.stderr.write(
          `${issue}\nusage: codemaster status [--root <dir>] [--full] [--brief] [--op <name>]\n`,
        );
        return 2;
      }
      const orchestrator = buildOrchestrator();
      const view = await orchestrator.status(process.cwd(), root);
      out(renderStatus(view, { full, brief, op }));
      await orchestrator.dispose();
      return 0;
    }
    case 'op': {
      const parsed = parseOpCommand(args);
      if (!parsed.ok) {
        process.stderr.write(parsed.message);
        return 2;
      }
      const { request, sql, returnMode } = parsed;
      const orchestrator = buildOrchestrator();
      // One render wiring for every dispatch path (`cli/compose.ts`): a dispatch error renders as a
      // valid JSON envelope under json / the dense `DISPATCH` line otherwise, and flips the exit
      // code non-zero (§3, t-337633) — the CLI mirror of the MCP `isError:true` — while a
      // structured ok:false ToolFailure stays a success-exit answer (it is an honest result).
      const composed =
        sql === undefined
          ? await runOp(orchestrator, process.cwd(), root, request)
          : await runOpSql(orchestrator, process.cwd(), root, request, {
              sql,
              ...(returnMode !== undefined ? { return: returnMode } : {}),
            });
      return await emit(composed, orchestrator);
    }
    case 'batch': {
      // The composition surface (§11) on the one-shot path: many ops in one dispatch, optionally
      // joined by a single read-only SELECT over their aliased tables.
      const parsed = parseBatchCommand(args, root);
      if (!parsed.ok) {
        process.stderr.write(`${parsed.message}\n${BATCH_USAGE}`);
        return 2;
      }
      const orchestrator = buildOrchestrator();
      return await emit(await runCompose(orchestrator, process.cwd(), parsed.plan), orchestrator);
    }
    case undefined:
    default:
      process.stderr.write(
        `codemaster v${VERSION}\nusage:\n  codemaster mcp            serve MCP over stdio (the daemon bridge)\n  codemaster daemon <status|start|stop|restart>   manage the singleton daemon\n  codemaster status [--root <dir>]\n  codemaster op <name> [json-args] [--root <dir>] [--format text|json] [--apply] [--summaryOnly] [--verbosity terse|normal|full] [--sql '<SELECT>'] [--return sql|all]\n  codemaster batch '<json-requests>' [--sql '<SELECT>'] [--return sql|all] [--root <dir>]\n`,
      );
      return command === undefined || command === 'help' ? 0 : 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`codemaster: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
