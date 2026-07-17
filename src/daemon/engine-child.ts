// The engine child process (process-mode isolation, §2/§9). One forked child hosts exactly
// ONE workspace engine — own heap + `--max-old-space-size` (set by the parent at fork), so a
// gigabyte-scale LS warm that would OOM the shared daemon in-process instead dies HERE, taking
// only this child with it (crash-isolation, t-167395). It rebuilds the engine from the project's
// own config (plugins/ops/seams are closures — they can't cross the fork boundary, so the child
// reconstructs them via the production composition root passed in), then serves request /
// produceSql / status / dispose over the fork IPC channel, reusing `createEngine` unchanged.
//
// Anti-orphan (§9): `process.on('disconnect')` fires when the parent dies — the child then
// self-exits, so a SIGKILLed daemon never leaves a warm LS squatting the user's RAM.
//
// Never-hang (§1, t-350294): the heavy synchronous work (warm LS, program build, find_usages) now
// runs HERE in the forked child, so the breadcrumb-watchdog (t-095661) is armed HERE too — a sync
// wedge inside the child writes a stall breadcrumb + SIGKILLs itself (backstop 1). This complements
// the parent-side kill-on-deadline (t-063850): the child self-diagnoses+kills from the inside. It is
// `orphanAware` (unlike `daemon serve`, which is detached): the child's parent is the daemon, NOT
// init, so the getppid orphan poll is a cheap res+ to the PRIMARY `disconnect` path — a belt for a
// missed IPC EOF (defense-in-depth, incident t-895142). Both routes converge on the same idempotent
// graceful shutdown (`shutdown` below).

import process from 'node:process';
import type { CodemasterConfig } from '../config/config.ts';
import type { Plugin } from '../core/plugin.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoId } from '../core/brands.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import { systemClock } from '../common/async/clock.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import { createDebugSystem } from '../support/debug/system.ts';
import { createStderrSink } from '../support/debug/stderr-sink.ts';
import { createChokidarWatcher } from '../support/watch/chokidar.ts';
import { installWatchdog } from '../support/watchdog/install.ts';
import { loadConfig } from '../support/config-load/load.ts';
import { isOk } from '../common/result/narrow.ts';
import { attachRepoLogSink } from './repo-log-sink.ts';
import { createEngine, type WorkspaceEngine } from './engine.ts';
import { parseEngineRequest, type EngineReply, type EngineStartup } from './engine-protocol.ts';

export interface EngineChildDeps {
  /** Canonical workspace root (= repoId; the parent forks one child per root). */
  root: string;
  version: string;
  /** State base (`~/.codemaster`) — per-repo debug log + feedback inbox, same as in-process. */
  stateDir: string;
  /** Production plugin/op builders (owned by the composition root, bin.ts) — passed in so the
   *  child stays free of every plugin import and the layering contract holds. */
  pluginsFor: (config: CodemasterConfig, root: string) => readonly Plugin[];
  opsFor: (config: CodemasterConfig) => readonly AnyOpDefinition[];
}

function send(frame: EngineReply | EngineStartup): void {
  process.send?.(frame as unknown as JsonValue);
}

/** Resolver for the serve promise, shared so `onOrphan` (fired from the watchdog poll, outside the
 *  Promise executor) can drive the same graceful shutdown. */
let resolveExit: () => void = () => undefined;

let shuttingDown = false;

/** Build the one engine and serve it over the fork IPC channel until the parent disposes or
 *  dies. Resolves when the child has committed to exit (dispose / disconnect); a build failure
 *  emits `fatal` and exits non-zero so the parent's spawn returns an honest failure. */
export async function serveEngineChild(deps: EngineChildDeps): Promise<void> {
  // §3.6: a stray rejection must never crash the child silently — trace and stay up.
  process.on('uncaughtException', (err) => process.stderr.write(`engine-child: ${err.message}\n`));
  process.on('unhandledRejection', (err) =>
    process.stderr.write(`engine-child: unhandled rejection: ${String(err)}\n`),
  );

  const debugSpec = process.env['CODEMASTER_DEBUG'] ?? '';
  const debug = createDebugSystem(systemClock, debugSpec);
  if (process.env['CODEMASTER_DEBUG'] !== undefined) debug.addSink(createStderrSink());

  const loaded = loadConfig(deps.root);
  if (!isOk(loaded)) {
    send({ kind: 'fatal', message: `config: ${loaded.failure.message}` });
    process.exit(1);
  }
  const { config, source } = loaded.data;
  attachRepoLogSink(debug, deps.stateDir, deps.root as RepoId, deps.root, config.debug?.logMaxMB);

  const created = await createEngine({
    repoId: deps.root as RepoId,
    root: deps.root,
    configSource: source,
    version: deps.version,
    stateDir: deps.stateDir,
    isolation: 'process',
    plugins: deps.pluginsFor(config, deps.root),
    ops: deps.opsFor(config),
    clock: systemClock,
    debug,
    watcher: createChokidarWatcher(systemClock),
  });
  if (!created.ok) {
    send({ kind: 'fatal', message: created.message });
    process.exit(1);
  }
  const engine = created.engine;

  // §1 never-hang: arm the breadcrumb-watchdog for the heavy sync that now lives in this child.
  // Best-effort (a broken watchdog returns a no-op handle, never touches the serve path).
  const watchdog = installWatchdog({
    clock: systemClock,
    orphanAware: true,
    // The orphan poll (missed-disconnect belt) routes through the SAME graceful shutdown as the
    // primary `disconnect` path, not a bare SIGTERM — dispose the warm LS, then exit.
    onOrphan: () => void shutdown(engine, watchdog, resolveExit),
    log: (m) => process.stderr.write(`engine-child watchdog: ${m}\n`),
  });

  await new Promise<void>((resolve) => {
    resolveExit = resolve;
    process.on('message', (raw) => void handle(engine, watchdog, raw as JsonValue, resolve));
    // Parent died (§9 anti-orphan): drop the warm LS with the process, don't squat RAM.
    process.on('disconnect', () => void shutdown(engine, watchdog, resolve));
    send({ kind: 'ready' });
  });
}

/** Grace for `engine.dispose()` (chokidar close + plugin dispose — async I/O that could hang) before
 *  we exit anyway. §1: on the ORPHAN path the parent is already gone, so there is no external reaper;
 *  a hung dispose must NOT leave the warm-LS child squatting RAM. The watchdog stays armed until the
 *  exit, and this deadline is the hard backstop for an async hang the idle-beacon worker won't catch. */
const DISPOSE_DEADLINE_MS = 10_000;

/** Idempotent graceful teardown: dispose the engine (drop the warm LS) under a deadline, stop the
 *  watchdog, exit 0. Reached from `disconnect`, the orphan poll, or a `dispose` request — a double
 *  call is a no-op (the sync `shuttingDown` flip precedes the first await). */
async function shutdown(
  engine: WorkspaceEngine,
  watchdog: { stop: () => void },
  done: () => void,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let exited = false;
  const forceExit = (): void => {
    if (exited) return;
    exited = true;
    try {
      watchdog.stop(); // teardown at the LAST moment — armed through dispose as a belt
    } catch {
      /* watchdog teardown is best-effort */
    }
    done();
    process.exit(0);
  };
  const bail = systemClock.schedule(DISPOSE_DEADLINE_MS, forceExit);
  try {
    await engine.dispose();
  } catch {
    /* a dispose failure is still an exit — never a hang */
  } finally {
    bail();
    forceExit();
  }
}

async function handle(
  engine: WorkspaceEngine,
  watchdog: { stop: () => void },
  raw: JsonValue,
  done: () => void,
): Promise<void> {
  const parsed = parseEngineRequest(raw);
  if (!parsed.ok) {
    send({ id: idOf(raw), kind: 'error', message: `bad request envelope: ${parsed.error}` });
    return;
  }
  const req = parsed.value;
  try {
    if (req.kind === 'dispose') {
      send({ id: req.id, kind: 'dispose' });
      await shutdown(engine, watchdog, done);
    } else if (req.kind === 'status') {
      send({ id: req.id, kind: 'status', view: await engine.status() });
    } else if (req.kind === 'produceSql') {
      const out = await engine.produceSql(req.reqs);
      send({
        id: req.id,
        kind: 'produceSql',
        results: out.results,
        ...(out.freshness !== undefined ? { freshness: out.freshness } : {}),
      });
    } else {
      send({ id: req.id, kind: 'request', results: await engine.request(req.reqs, req.batch) });
    }
  } catch (thrown) {
    // §3.6 — a routing/op crash is an honest error reply, never a child-down or a hang.
    send({ id: req.id, kind: 'error', message: messageOfThrown(thrown) });
  }
}

function idOf(raw: JsonValue): number {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const id = (raw as { [k: string]: JsonValue })['id'];
    if (typeof id === 'number') return id;
  }
  return 0;
}
