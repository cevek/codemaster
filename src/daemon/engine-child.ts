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

  await new Promise<void>((resolve) => {
    process.on('message', (raw) => void handle(engine, raw as JsonValue, resolve));
    // Parent died (§9 anti-orphan): drop the warm LS with the process, don't squat RAM.
    process.on('disconnect', () => {
      void engine.dispose().finally(() => process.exit(0));
    });
    send({ kind: 'ready' });
  });
}

async function handle(engine: WorkspaceEngine, raw: JsonValue, done: () => void): Promise<void> {
  const parsed = parseEngineRequest(raw);
  if (!parsed.ok) {
    send({ id: idOf(raw), kind: 'error', message: `bad request envelope: ${parsed.error}` });
    return;
  }
  const req = parsed.value;
  try {
    if (req.kind === 'dispose') {
      await engine.dispose();
      send({ id: req.id, kind: 'dispose' });
      done();
      process.exit(0);
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
