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
import { renderResult, renderResultJson } from './format/render/render-result.ts';
import { renderStatus } from './format/render/render-status.ts';
import { serveMcp } from './mcp/server.ts';
import { dispatchErrorLine } from './mcp/render-dispatch-error.ts';
import { defaultUsageLogger } from './support/usage-log/default.ts';
import { serveDaemon } from './daemon/daemon-server.ts';
import { connectOrSpawnDaemon } from './daemon/connect-or-spawn.ts';
import { spawnDaemon } from './daemon/spawn-daemon.ts';
import { runDaemonCommand } from './daemon/manage.ts';
import { createRemoteOrchestrator } from './daemon/remote-orchestrator.ts';
import { createUnixSocketTransport } from './support/transport/unix-socket.ts';
import { socketPath } from './support/transport/socket-path.ts';
import { installWatchdog } from './support/watchdog/install.ts';
import { makeProcessHostFactory } from './daemon/process-host-factory.ts';
import { serveEngineChild } from './daemon/engine-child.ts';

/** Per-request reply deadline for the bridge (§1 never-hang). Generous — a cold find_usages on a
 *  huge repo can run tens of seconds (§1 latency budget) — but bounded so a wedged daemon yields an
 *  honest failure and the agent falls back, never an unbounded wait. */
const BRIDGE_REPLY_DEADLINE_MS = 120_000;

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

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

/** A value-bearing flag accepting BOTH spellings — `--flag value` and `--flag=value` — and
 *  spliced out either way (the `=` form is one token). The equals form is checked first so a
 *  `--format=json` never falls through to the space-form lookup and gets left behind. */
function flagValue(args: string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  const eqIdx = args.findIndex((a) => a.startsWith(eqPrefix));
  if (eqIdx !== -1) {
    const value = args[eqIdx]?.slice(eqPrefix.length) ?? '';
    args.splice(eqIdx, 1);
    return value;
  }
  return argValue(args, flag);
}

/** A valueless boolean flag (`--apply`, `--summaryOnly`): present → true, and spliced out so it
 *  never collides with the positional JSON-args lookup. */
function hasFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** After every KNOWN flag has been spliced out, any residual `--`-prefixed token is an
 *  unrecognized flag. Returns them so the caller can reject LOUDLY (§3: a silent drop is the exact
 *  intake anti-pattern the tool forbids) — naming the offending flags + the command usage. Empty
 *  array ⇒ nothing stray, caller proceeds. */
function unknownFlags(args: readonly string[]): string[] {
  return args.filter((a) => a.startsWith('--'));
}

async function main(): Promise<number> {
  // §3.6: a stray rejection must never take the front door down.
  process.on('uncaughtException', (err) => process.stderr.write(`codemaster: ${err.message}\n`));
  process.on('unhandledRejection', (err) =>
    process.stderr.write(`codemaster: unhandled rejection: ${String(err)}\n`),
  );

  const args = process.argv.slice(2);
  // `--root` is a position-free GLOBAL flag: extract it from the whole argv BEFORE shifting the
  // subcommand, so `--root <dir> op …` parses as well as `op … --root <dir>` (t-713862). argValue
  // splices it wherever it sits, so the shift below always lands on the real subcommand token.
  const root = argValue(args, '--root');
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
        // ONE workspace engine over the fork IPC channel; its heap is bounded by the parent's
        // `--max-old-space-size`, so a warm that would OOM the shared daemon dies HERE instead.
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
      // `--root` is the only flag `status` accepts (extracted globally above). Anything else
      // `--`-prefixed is unrecognized — reject, never drop (§3 silent-swallow).
      const stray = unknownFlags(args);
      if (stray.length > 0) {
        process.stderr.write(
          `unrecognized flag(s): ${stray.join(', ')}\nusage: codemaster status [--root <dir>]\n`,
        );
        return 2;
      }
      const orchestrator = buildOrchestrator();
      const view = await orchestrator.status(process.cwd(), root);
      out(renderStatus(view));
      await orchestrator.dispose();
      return 0;
    }
    case 'op': {
      const OP_USAGE =
        'usage: codemaster op <name> [json-args] [--root <dir>] [--format text|json] [--apply] [--summaryOnly] [--verbosity terse|normal|full]\n';
      const name = args.shift();
      if (name === undefined) {
        process.stderr.write(OP_USAGE);
        return 2;
      }
      const verbosity = argValue(args, '--verbosity');
      const v = verbosity === 'normal' || verbosity === 'full' ? verbosity : 'terse';
      // `--format json` mirrors the MCP `format` flag: json routes the envelope through the SAME
      // `renderResultJson` the MCP path uses (byte parity, no parallel serializer). An unknown
      // value is rejected (not silently coerced to text) — the CLI mirror of the MCP zod enum.
      const format = flagValue(args, '--format');
      if (format !== undefined && format !== 'text' && format !== 'json') {
        process.stderr.write(`--format must be 'text' or 'json' (got '${format}')\n${OP_USAGE}`);
        return 2;
      }
      // Mutating-op flags (§7): without these a CLI `op` could only ever dry-run, so a mutating op
      // can't be dogfooded from the CLI. Parsed (and spliced) BEFORE the positional JSON-args find.
      const apply = hasFlag(args, '--apply');
      const summaryOnly = hasFlag(args, '--summaryOnly');
      // Every KNOWN flag is now spliced out; any residual `--`-token is unrecognized → reject,
      // never drop (§3). Checked before the op runs so a typo'd flag never yields a misleading
      // "success" over unintended defaults.
      const stray = unknownFlags(args);
      if (stray.length > 0) {
        process.stderr.write(`unrecognized flag(s): ${stray.join(', ')}\n${OP_USAGE}`);
        return 2;
      }
      // Every known flag and any unrecognized `--` token is now handled, so `args` holds only
      // positionals. The op takes at most ONE (the JSON args); a second bareword is stray input →
      // reject LOUDLY (exit 2, named), never drop it (§3 silent-swallow, positional half — t-865108).
      if (args.length > 1) {
        process.stderr.write(`unexpected argument(s): ${args.slice(1).join(', ')}\n${OP_USAGE}`);
        return 2;
      }
      let opArgs: unknown = {};
      const rawArgs = args[0];
      if (rawArgs !== undefined) {
        try {
          opArgs = JSON.parse(rawArgs);
        } catch {
          process.stderr.write(`args is not valid JSON: ${rawArgs}\n`);
          return 2;
        }
      }
      const orchestrator = buildOrchestrator();
      // Thread verbosity into the REQUEST (not just the render), so an op that shapes its DATA by
      // density — expand_type lifts its member cap at full (§3.4 completeness) — sees it in
      // `ctx.flags`. The MCP path already carries it; without this the CLI would render `full` over
      // data the op capped at the terse default. Ops that ignore verbosity are unaffected.
      const outcome = await orchestrator.request(process.cwd(), root, [
        { name, args: opArgs as never, apply, summaryOnly, verbosity: v },
      ]);
      if (!outcome.ok) {
        process.stderr.write(`${outcome.message}\n`);
        await orchestrator.dispose();
        return 1;
      }
      // A dispatch error (unknown_op / bad_args / op_threw / unavailable) is a request-level
      // NON-result: `dispatchErrorLine` (SHARED with the MCP path, no parallel serializer) emits a
      // valid JSON envelope under json, else the dense `DISPATCH` line. It
      // also flips the exit code non-zero (§3, t-337633) — the CLI mirror of the MCP `isError:true`
      // — so a `--format json | jq` consumer never reads a non-result on a success exit code. A
      // structured ok:false ToolFailure stays a JSON success-exit answer (it's an honest result).
      let dispatchFailed = false;
      for (const r of outcome.results) {
        if ('error' in r) {
          out(dispatchErrorLine(r.error, format));
          dispatchFailed = true;
        } else out(format === 'json' ? renderResultJson(r.result) : renderResult(r.result, v));
      }
      await orchestrator.dispose();
      return dispatchFailed ? 1 : 0;
    }
    case undefined:
    default:
      process.stderr.write(
        `codemaster v${VERSION}\nusage:\n  codemaster mcp            serve MCP over stdio (the daemon bridge)\n  codemaster daemon <status|start|stop|restart>   manage the singleton daemon\n  codemaster status [--root <dir>]\n  codemaster op <name> [json-args] [--root <dir>] [--format text|json] [--apply] [--summaryOnly] [--verbosity terse|normal|full]\n`,
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
