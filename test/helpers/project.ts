// `project()` — the honesty-harness fixture mount (§16): a temp git repo built from a
// `{ path: source }` map, driving the REAL pipeline (orchestrator → engine → plugins)
// with the watcher silenced (nullWatcher) so every test exercises the read-time
// freshness backstop, and an injected manual clock so nothing sleeps.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Clock } from '../../src/common/async/clock.ts';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { nullWatcher } from '../../src/support/watch/seam.ts';
import { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { createScssPlugin } from '../../src/plugins/scss/plugin.ts';
import { createI18nPlugin } from '../../src/plugins/i18n/plugin.ts';
import { createSchemaPlugin } from '../../src/plugins/schema/plugin.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { renderStatus } from '../../src/format/render/render-status.ts';
import type { BatchOptions, OpRequest, OpResult } from '../../src/ops/contracts.ts';
import type { SqlBounds } from '../../src/daemon/sql-batch.ts';
import type { createSqliteRunner } from '../../src/support/sql/better-sqlite3.ts';
import type { TextScanner } from '../../src/support/text-search/scan.ts';
import type { GitRunner } from '../../src/support/git/run.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Result } from '../../src/core/result.ts';
import { extractText } from '../../src/common/span/extract-text.ts';

export interface TestProject {
  root: string;
  op(name: string, args: JsonValue): Promise<OpResult>;
  /** The rendered `status` reply for this workspace (the per-repo documentation). */
  status(): Promise<string>;
  /** Drive a (sql-)batch directly: returns the engine's ordered results, unrendered. */
  request(reqs: readonly OpRequest[], batch?: BatchOptions): Promise<readonly OpResult[]>;
  write(rel: string, content: string): void;
  remove(rel: string): void;
  git(...args: string[]): string;
  /** `git add -A` + commit with a fixed test identity (configured at init, so no per-call
   *  `-c user.email/-c user.name` incantation is needed). */
  commit(message: string): void;
  clock: Clock & { advance(ms: number): void };
  dispose(): Promise<void>;
}

export interface ProjectOptions {
  /** Lower the sql-mode row bounds to avoid 100k-row fixtures (spec §7.3/§7.4). */
  sqlBounds?: Partial<SqlBounds>;
  /** Swap the SQL evaluator (e.g. to force the native-load failure path). */
  createSqlRunner?: () => ReturnType<typeof createSqliteRunner>;
  /** Swap the text scanner (e.g. to force the text-scan failure path, §text-overlay). */
  createTextScanner?: () => TextScanner;
  /** Override the state base (feedback inbox + debug log). Defaults under `root`; tests
   *  that assert the repo tree is untouched point this OUTSIDE the repo (as production's
   *  `~/.codemaster` is). */
  stateDir?: string;
  /** Force the freshness-path git runner to fail (§3.6 resilience injection via seam,
   *  never by breaking the host). `args[0]` selects which git subcommand faults. */
  gitRunner?: GitRunner;
  /** Break one `ts` plugin method so it throws — proves the op-level wrap turns an LS
   *  fault into an honest `ToolFailure` (not an `op_threw` crash), daemon staying live. */
  faultTsMethod?: 'findUsages' | 'expandType';
  /** Codemaster's own source fingerprint (the self-staleness seam — §3.6). Defaults to a
   *  constant so tests never walk the real `src/`; a staleness test injects a value that
   *  changes after spawn to drive the "daemon behind source" signal. */
  sourceFingerprint?: () => string;
}

/** Replace one method on the `ts` plugin object with a throwing stub (§3.6 fault injection
 *  via a seam, not by breaking the host). The op that calls it must turn the throw into an
 *  honest `ToolFailure`; if the op forgot its wrap, the engine reports `op_threw` and the
 *  resilience test catches the regression. */
function faultTs(api: TsPluginApi, method: 'findUsages' | 'expandType' | undefined): TsPluginApi {
  if (method === undefined) return api;
  api[method] = (): never => {
    throw new Error(`injected ${method} LS fault`);
  };
  return api;
}

export function manualClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
  };
}

export async function project(
  files: Record<string, string>,
  options?: ProjectOptions,
): Promise<TestProject> {
  // Canonicalize the temp root through the same `realpath` policy the renderer/resolver
  // apply (§19): on macOS `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/…`,
  // so the un-canonicalized mkdtemp path would not match the realpath'd root every answer
  // reports — breaking path scrubs and golden snapshots across platforms.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'codemaster-fixture-')));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const commit = (message: string): void => {
    git('add', '-A');
    git('commit', '-qm', message);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git('init', '-q');
  // Configure the test identity ONCE so bare `git commit` works everywhere — no per-call
  // `-c user.email/-c user.name` incantation in test bodies or here. Disable signing so a
  // developer's global `commit.gpgsign=true` can't hang/fail the fixture commits in CI.
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  commit('fixture');

  const clock = manualClock();
  const debug = createDebugSystem(clock);
  const orchestrator = new Orchestrator({
    clock,
    debug,
    watcher: nullWatcher, // silenced on purpose: the read-time backstop must carry it
    version: 'test',
    stateDir: options?.stateDir ?? path.join(root, '.codemaster-state'),
    ...(options?.sqlBounds !== undefined ? { sqlBounds: options.sqlBounds } : {}),
    ...(options?.createSqlRunner !== undefined ? { createSqlRunner: options.createSqlRunner } : {}),
    ...(options?.createTextScanner !== undefined
      ? { createTextScanner: options.createTextScanner }
      : {}),
    ...(options?.gitRunner !== undefined ? { gitRunner: options.gitRunner } : {}),
    // Default to a constant so the suite never stat-walks the real `src/`; a staleness test
    // overrides it with a value that changes after spawn.
    sourceFingerprint: options?.sourceFingerprint ?? ((): string => 'test-src'),
    pluginsFor: (config, repoRoot) => [
      faultTs(createTsPlugin(repoRoot, config.ts?.tsconfig), options?.faultTsMethod),
      createScssPlugin(repoRoot),
      ...(config.i18n !== undefined
        ? [createI18nPlugin(repoRoot, config.i18n.locales, config.i18n.functions)]
        : []),
      ...(config.schema !== undefined
        ? [createSchemaPlugin(repoRoot, [config.schema.entrypoint])]
        : []),
    ],
    opsFor: () => builtinOps(),
  });

  return {
    root,
    clock,
    git,
    commit,
    write,
    remove: (rel) => rmSync(path.join(root, rel)),
    async op(name, args) {
      const outcome = await orchestrator.request(root, root, [{ name, args }]);
      if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.message}`);
      const result = outcome.results[0];
      if (result === undefined) throw new Error('no result');
      return result;
    },
    async status() {
      return renderStatus(await orchestrator.status(root, root));
    },
    async request(reqs, batch) {
      const outcome = await orchestrator.request(root, root, reqs, batch);
      if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.message}`);
      return outcome.results;
    },
    async dispose() {
      await orchestrator.dispose();
      debug.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** §16 invariant 1 — proof-span validity: every emitted `Span.text` equals the live
 *  source at its range. The oracle is the file on disk, read independently. */
type SpanLike = {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
  elided?: boolean;
};

/** Returns the number of proof spans validated — lets a caller assert an op was actually
 *  exercised (a zero-span answer passing vacuously is the §16 inv. 1 hollow-green trap). */
export function assertSpansValid(root: string, result: OpResult): number {
  if (!('result' in result)) return 0;
  const spans: SpanLike[] = [];
  collectSpans(resultData(result.result), spans);
  for (const span of spans) {
    const source = readFileSync(path.join(root, span.file), 'utf8');
    const actual = extractText(source, span);
    if (actual === undefined) {
      throw new Error(`span out of range: ${span.file}:${span.line}:${span.col}`);
    }
    if (span.elided === true) {
      const head = span.text.replace(/…$/, '');
      if (!actual.startsWith(head)) {
        throw new Error(`elided span text drifted at ${span.file}:${span.line}`);
      }
    } else if (actual !== span.text) {
      throw new Error(
        `span text drifted at ${span.file}:${span.line}:${span.col} — span says ${JSON.stringify(span.text)}, source says ${JSON.stringify(actual)}`,
      );
    }
  }
  return spans.length;
}

function resultData(result: Result<JsonValue>): JsonValue {
  return (result.ok ? result.data : (result.data ?? null)) ?? null;
}

function collectSpans(value: JsonValue, out: SpanLike[]): void {
  if (isJsonArray(value)) {
    for (const v of value) collectSpans(v, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, JsonValue>;
    if (
      typeof v['file'] === 'string' &&
      typeof v['line'] === 'number' &&
      typeof v['col'] === 'number' &&
      typeof v['endLine'] === 'number' &&
      typeof v['endCol'] === 'number' &&
      typeof v['text'] === 'string'
    ) {
      // Structure verified field-by-field right above.
      out.push(v as SpanLike);
    }
    for (const child of Object.values(v)) collectSpans(child, out);
  }
}

// `Array.isArray` narrows a readonly union member to `any[]`; keep the element type.
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
