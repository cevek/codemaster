#!/usr/bin/env node
// codemaster — CLI / process entry (composition root). Wires clock + debug + watcher
// + built-in plugins/ops into an orchestrator, then serves MCP over stdio
// (`codemaster mcp`) or answers one-shot CLI queries (`status`, `op`).
//
// stdout carries ONLY the agent-facing payload; all tracing goes to stderr/file via
// the debug subsystem (§13).

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { CodemasterConfig } from './config/config.ts';
import type { Plugin } from './core/plugin.ts';
import { systemClock } from './common/async/clock.ts';
import { createDebugSystem } from './support/debug/system.ts';
import { createStderrSink } from './support/debug/stderr-sink.ts';
import { createChokidarWatcher } from './support/watch/chokidar.ts';
import { Orchestrator, DEFAULT_IDLE_EVICTION_MIN } from './daemon/orchestrator.ts';
import { loadConfig } from './support/config-load/load.ts';
import { isOk } from './common/result/narrow.ts';
import { createTsPlugin } from './plugins/ts/plugin.ts';
import { createScssPlugin } from './plugins/scss/plugin.ts';
import { createI18nPlugin } from './plugins/i18n/plugin.ts';
import { createSchemaPlugin } from './plugins/schema/plugin.ts';
import { builtinOps } from './ops/builtins.ts';
import { renderResult } from './format/render/render-result.ts';
import { renderStatus } from './format/render/render-status.ts';
import { serveMcp } from './mcp/server.ts';
import { serveDaemon } from './daemon/daemon-server.ts';
import { connectOrSpawnDaemon } from './daemon/connect-or-spawn.ts';
import { spawnDaemon } from './daemon/spawn-daemon.ts';
import { runDaemonCommand } from './daemon/manage.ts';
import { createRemoteOrchestrator } from './daemon/remote-orchestrator.ts';
import { createUnixSocketTransport } from './support/transport/unix-socket.ts';
import { socketPath } from './support/transport/socket-path.ts';

/** Per-request reply deadline for the bridge (§1 never-hang). Generous — a cold find_usages on a
 *  huge repo can run tens of seconds (§1 latency budget) — but bounded so a wedged daemon yields an
 *  honest failure and the agent falls back, never an unbounded wait. */
const BRIDGE_REPLY_DEADLINE_MS = 120_000;

const VERSION = '0.1.0';

function builtinPlugins(config: CodemasterConfig, root: string): readonly Plugin[] {
  // The i18n + schema plugins are config-gated (no autodetection v1): enabled iff their
  // config section is present. The gate lives HERE in pluginsFor, never in opsFor — the
  // ops register unconditionally and are gated by plugin presence via `requires`
  // (§ spec-i18n-plugin / spec-schema-plugin).
  return [
    createTsPlugin(root, config.ts?.tsconfig),
    createScssPlugin(root),
    ...(config.i18n !== undefined
      ? [
          createI18nPlugin(root, config.i18n.locales, config.i18n.functions, {
            module: config.i18n.module,
            hook: config.i18n.hook,
          }),
        ]
      : []),
    // Only the `openapi-typescript` shape is parsed; `generator: 'custom'` (orval etc.) is a
    // stated follow-up, so don't load a parser that can't read it — keep `list_endpoints` out
    // of the catalogue honestly rather than offer an op that yields zero cards.
    ...(config.schema !== undefined && config.schema.generator !== 'custom'
      ? [createSchemaPlugin(root, [config.schema.entrypoint])]
      : []),
  ];
}

function buildOrchestrator(): Orchestrator {
  const debug = createDebugSystem(systemClock, process.env['CODEMASTER_DEBUG'] ?? '');
  if (process.env['CODEMASTER_DEBUG'] !== undefined) debug.addSink(createStderrSink());
  return new Orchestrator({
    clock: systemClock,
    debug,
    watcher: createChokidarWatcher(systemClock),
    version: VERSION,
    pluginsFor: builtinPlugins,
    opsFor: () => builtinOps(),
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

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

/** A valueless boolean flag (`--apply`, `--summaryOnly`): present → true, and spliced out so it
 *  never collides with the positional JSON-args lookup. */
function hasFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

async function main(): Promise<number> {
  // §3.6: a stray rejection must never take the front door down.
  process.on('uncaughtException', (err) => process.stderr.write(`codemaster: ${err.message}\n`));
  process.on('unhandledRejection', (err) =>
    process.stderr.write(`codemaster: unhandled rejection: ${String(err)}\n`),
  );

  const args = process.argv.slice(2);
  const command = args.shift();
  const root = argValue(args, '--root');

  switch (command) {
    case 'daemon': {
      // `daemon` is a sub-router (spec-daemon-cli). `serve` is the INTERNAL long-lived singleton the
      // bridge spawns (spec-daemon-singleton §2) — it needs an orchestrator and stays here. The
      // user-facing management verbs (`start`/`stop`/`restart`/`status`) are pure socket clients and
      // live in `daemon/manage.ts`. Bare `daemon` (or an unknown verb) prints usage.
      const verb = args.shift();
      if (verb === 'serve') {
        // Hosts one in-process orchestrator behind the unix socket, shared across every bridge.
        const orchestrator = buildOrchestrator();
        const socket = socketPath(VERSION, process.env['CODEMASTER_SOCK_DIR']);
        const transport = createUnixSocketTransport(socket);
        try {
          await serveDaemon({
            orchestrator,
            transport,
            clock: systemClock,
            idleMs: mcpIdleMs(process.cwd()),
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
        clock: systemClock,
        spawnDaemon: () => spawnDaemon(binPath, process.env['CODEMASTER_SOCK_DIR']),
      });
      for (const line of result.lines) out(line);
      return result.code;
    }
    case 'mcp': {
      const idleMs = mcpIdleMs(root ?? process.cwd());
      // `--in-process` escape hatch (spec §5): serve a local orchestrator directly, no daemon —
      // for debugging and the self-dev loop. Carries the Stage-1 idle self-exit.
      if (hasFlag(args, '--in-process')) {
        await serveMcp(buildOrchestrator(), VERSION, { idle: { clock: systemClock, idleMs } });
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
        await serveMcp(buildOrchestrator(), VERSION, { idle: { clock: systemClock, idleMs } });
        return -1;
      }
      const remote = createRemoteOrchestrator({
        connection,
        clock: systemClock,
        replyDeadlineMs: BRIDGE_REPLY_DEADLINE_MS,
        version: VERSION,
      });
      await serveMcp(remote, VERSION);
      return -1; // stays alive serving stdio until the client closes stdin
    }
    case 'status': {
      const orchestrator = buildOrchestrator();
      const view = await orchestrator.status(process.cwd(), root);
      out(renderStatus(view));
      await orchestrator.dispose();
      return 0;
    }
    case 'op': {
      const name = args.shift();
      if (name === undefined) {
        process.stderr.write(
          'usage: codemaster op <name> [json-args] [--root <dir>] [--apply] [--summaryOnly] [--verbosity terse|normal|full]\n',
        );
        return 2;
      }
      const verbosity = argValue(args, '--verbosity');
      const v = verbosity === 'normal' || verbosity === 'full' ? verbosity : 'terse';
      // Mutating-op flags (§7): without these a CLI `op` could only ever dry-run, so a mutating op
      // can't be dogfooded from the CLI. Parsed (and spliced) BEFORE the positional JSON-args find.
      const apply = hasFlag(args, '--apply');
      const summaryOnly = hasFlag(args, '--summaryOnly');
      let opArgs: unknown = {};
      const rawArgs = args.find((a) => !a.startsWith('--'));
      if (rawArgs !== undefined) {
        try {
          opArgs = JSON.parse(rawArgs);
        } catch {
          process.stderr.write(`args is not valid JSON: ${rawArgs}\n`);
          return 2;
        }
      }
      const orchestrator = buildOrchestrator();
      const outcome = await orchestrator.request(process.cwd(), root, [
        { name, args: opArgs as never, apply, summaryOnly },
      ]);
      if (!outcome.ok) {
        process.stderr.write(`${outcome.message}\n`);
        await orchestrator.dispose();
        return 1;
      }
      for (const r of outcome.results) {
        if ('error' in r) out(`DISPATCH ${r.error.kind}: ${r.error.message}`);
        else out(renderResult(r.result, v));
      }
      await orchestrator.dispose();
      return 0;
    }
    case undefined:
    default:
      process.stderr.write(
        `codemaster v${VERSION}\nusage:\n  codemaster mcp            serve MCP over stdio (the daemon bridge)\n  codemaster daemon <status|start|stop|restart>   manage the singleton daemon\n  codemaster status [--root <dir>]\n  codemaster op <name> [json-args] [--root <dir>] [--apply] [--summaryOnly] [--verbosity terse|normal|full]\n`,
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
